"""Offline, conservative Game Effect file migrations. Python standard library only.

XLSX is patched as an OOXML ZIP package so unrelated sheets, styles and drawings
remain intact. No Excel installation, workbook recalculation or network is used.
"""
from __future__ import annotations

import copy
import csv
import datetime as dt
import hashlib
import io
import json
import posixpath
import re
import uuid
import zipfile
from collections import Counter
from dataclasses import dataclass, field
from decimal import Decimal, InvalidOperation, ROUND_HALF_UP
from pathlib import Path
from xml.dom import minidom

ROOT = Path(__file__).resolve().parent
RELEASE = json.loads((ROOT / 'release.json').read_text(encoding='utf-8'))
HEADERS = RELEASE['headers']
FIELDS = ['title', 'startDate', 'endDate', 'platform', 'time', 'isEnding',
          'memo', 'review', 'steamAppId', 'steamTotal', 'recordId',
          'playtimeMinutes', 'parentAppId', 'isLauncherAllocation',
          'calendarLinkStart', 'launcherChildAppId']
LABELS = dict(zip(FIELDS, HEADERS))
NS = 'http://schemas.openxmlformats.org/spreadsheetml/2006/main'
REL_NS = 'http://schemas.openxmlformats.org/officeDocument/2006/relationships'
MAX_BYTES = 150 * 1024 * 1024
MIGRATION_REGISTRY = {}


class MigrationError(ValueError):
    pass


def migration(name):
    def register(fn):
        MIGRATION_REGISTRY[name] = fn
        return fn
    return register


def blank(value):
    return value is None or (isinstance(value, str) and not value.strip())


def text(value):
    return '' if value is None else str(value).strip()


def truth(value):
    return value is True or text(value).lower() in ('y', 'true', '1')


def field_changed(key, before, after, tabular=False):
    old, new = before.get(key), after.get(key)
    if tabular and ((blank(old) and blank(new)) or (key == 'isLauncherAllocation' and truth(old) == new)):
        return False
    return key not in before or old != new


def decimal(value):
    if blank(value) or isinstance(value, bool):
        return None
    try:
        number = Decimal(str(value))
        return number if number.is_finite() and 0 <= number <= Decimal('100000000') else None
    except InvalidOperation:
        return None


def read_xml(data):
    if b'<!DOCTYPE' in data.upper() or b'<!ENTITY' in data.upper():
        raise MigrationError('외부 선언이 포함된 XML 파일은 처리하지 않습니다.')
    return minidom.parseString(data)


def children(node, name):
    return [n for n in node.childNodes if n.nodeType == n.ELEMENT_NODE and n.localName == name]


def elements(node, name):
    return list(node.getElementsByTagNameNS(NS, name))


def node_text(node):
    return ''.join(n.data for n in node.childNodes if n.nodeType in (n.TEXT_NODE, n.CDATA_SECTION_NODE))


def col_name(index):
    value = ''
    while index:
        index, rem = divmod(index - 1, 26)
        value = chr(65 + rem) + value
    return value


def col_index(reference):
    match = re.fullmatch(r'([A-Z]+)[1-9][0-9]*', reference)
    if not match:
        raise MigrationError(f'잘못된 셀 주소: {reference}')
    result = 0
    for char in match[1]:
        result = result * 26 + ord(char) - 64
    return result


@dataclass
class Plan:
    source: Path
    original: bytes
    converted: bytes = b''
    changes: list = field(default_factory=list)
    warnings: list = field(default_factory=list)
    records: int = 0
    sheets: list = field(default_factory=list)
    seen_ids: dict = field(default_factory=dict)
    seen_rows: dict = field(default_factory=dict)

    def change(self, location, label, before, after, rule):
        self.changes.append(dict(location=location, field=label, before=before, after=after, rule=rule))

    def warn(self, location, message):
        self.warnings.append(dict(location=location, message=message))

    def report(self):
        return dict(toolVersion=RELEASE['toolVersion'], targetSiteVersion=RELEASE['targetSiteVersion'],
                    schemaRevision=RELEASE['schemaRevision'], sourceVersion='파일에 버전 정보 없음 · 현재 구조로 판별',
                    sourceFile=self.source.name, sourceSha256=hashlib.sha256(self.original).hexdigest(),
                    outputSha256=hashlib.sha256(self.converted).hexdigest(),
                    status='확인 필요' if self.warnings else ('변환 완료' if self.changes else '변환할 내용 없음'),
                    recordCount=self.records, processedSheets=self.sheets,
                    changeCount=len(self.changes), warningCount=len(self.warnings),
                    changes=self.changes, warnings=self.warnings)


@migration('record-id')
def add_record_id(record, location, plan, event_id):
    if blank(record.get('recordId')):
        seed = json.dumps([location, [record.get(k) for k in FIELDS[:10]]], ensure_ascii=False, sort_keys=True, default=str)
        record['recordId'] = text(event_id) or 'rec_' + uuid.uuid5(uuid.NAMESPACE_URL, 'game-effect:' + seed).hex


@migration('minutes-from-hours')
def minutes_from_hours(record, location, plan, event_id):
    hours = decimal(record.get('time'))
    if hours is None:
        plan.warn(location, '플레이 시간이 비었거나 잘못되었습니다. 0시간으로 바꾸지 않고 보존했습니다.')
        return
    expected = int((hours * 60).quantize(Decimal('1'), rounding=ROUND_HALF_UP))
    if decimal(record.get('playtimeMinutes')) != Decimal(expected):
        record['playtimeMinutes'] = expected
    if hours != hours.quantize(Decimal('0.1'), rounding=ROUND_HALF_UP):
        plan.warn(location, '시간이 소수 첫째 자리보다 정밀합니다. 원본 값을 유지했으며 사이트에서는 반올림될 수 있습니다.')


@migration('launcher-metadata')
def launcher_metadata(record, location, plan, event_id):
    for key in ('parentAppId', 'calendarLinkStart', 'launcherChildAppId'):
        record.setdefault(key, '')
    allocated = truth(record.get('isLauncherAllocation')) or not blank(record.get('parentAppId'))
    record['isLauncherAllocation'] = allocated
    if allocated and blank(record.get('parentAppId')):
        plan.warn(location, '런처 배분 기록에 부모 AppID가 없습니다. 게임 분류를 추측하지 않았습니다.')
    parent, steam, child = (text(record.get(k)) for k in ('parentAppId', 'steamAppId', 'launcherChildAppId'))
    if parent and steam and parent != steam:
        plan.warn(location, '런처 부모 AppID와 Steam AppID가 다릅니다. 두 값을 그대로 보존했습니다.')
    if allocated and not child:
        plan.warn(location, '하위 게임 Steam AppID가 비어 있습니다. 기존 제목·부모 연결은 보존했으며 하위 ID를 추측하지 않았습니다.')


def migrate_record(record, location, plan, event_id='', tabular=False):
    before = copy.deepcopy(record)
    for rule in RELEASE['migrations']:
        MIGRATION_REGISTRY[rule](record, location, plan, event_id)
        for key, value in record.items():
            if field_changed(key, before, record, tabular):
                plan.change(location, LABELS.get(key, key), before.get(key), value, rule)
        before = copy.deepcopy(record)
    if blank(record.get('title')):
        plan.warn(location, '게임 제목이 비어 있습니다. 이 행은 사이트에서 표시되지 않을 수 있습니다.')
    if blank(record.get('startDate')) and blank(record.get('endDate')):
        plan.warn(location, '시작일과 종료일이 모두 비어 있습니다. 날짜를 임의로 생성하지 않았습니다.')
    for key in ('startDate', 'endDate', 'calendarLinkStart'):
        value = text(record.get(key))
        if value:
            try:
                if not re.fullmatch(r'\d{4}-\d{2}-\d{2}', value):
                    raise ValueError()
                dt.date.fromisoformat(value)
            except ValueError:
                plan.warn(location, f'{LABELS[key]} 형식을 확인해 주세요. 원본 날짜를 보존했습니다.')
    start, end = text(record.get('startDate')), text(record.get('endDate'))
    if re.fullmatch(r'\d{4}-\d{2}-\d{2}', start) and re.fullmatch(r'\d{4}-\d{2}-\d{2}', end) and end < start:
        plan.warn(location, '종료일이 시작일보다 빠릅니다. 자동으로 날짜를 뒤집지 않았습니다.')
    for key in ('steamAppId', 'parentAppId', 'launcherChildAppId'):
        if not blank(record.get(key)) and not re.fullmatch(r'[1-9]\d*', text(record[key])):
            plan.warn(location, f'{LABELS[key]}가 올바른 숫자 ID인지 확인해 주세요.')
    record_id = text(record.get('recordId'))
    if record_id in plan.seen_ids:
        plan.warn(location, f'기록 ID가 {plan.seen_ids[record_id]}와 중복됩니다. 행을 삭제하거나 합치지 않았습니다.')
    plan.seen_ids[record_id] = location
    identity = json.dumps([record.get(k) for k in FIELDS[:10]], ensure_ascii=False, sort_keys=True, default=str)
    if identity in plan.seen_rows:
        plan.warn(location, f'내용이 {plan.seen_rows[identity]}와 같은 기록입니다. 두 행 모두 보존했습니다.')
    plan.seen_rows[identity] = location
    plan.records += 1
    return record


def canonical_headers(headers):
    named = [h for h in headers if h]
    duplicates = [h for h, count in Counter(named).items() if count > 1]
    if duplicates:
        raise MigrationError('중복 열 이름을 먼저 정리해 주세요: ' + ', '.join(duplicates))
    if not all(h in headers for h in ('이름', '플랫폼', '시간')) or not any(h in headers for h in ('시작일', '종료일')):
        raise MigrationError('게임 기록 원본 열(이름·플랫폼·시간·시작일 또는 종료일)을 찾지 못했습니다.')
    # Keep all extra columns, including unnamed columns containing data.
    return list(HEADERS) + [h for h in headers if h not in HEADERS]


def table_record(row, headers):
    return {key: row[headers.index(label)] if label in headers and headers.index(label) < len(row) else ''
            for key, label in LABELS.items()}


def table_value(key, value):
    return ('Y' if value else '') if key == 'isLauncherAllocation' else ('' if value is None else value)


def migrate_csv(plan):
    try:
        content = plan.original.decode('utf-8-sig')
    except UnicodeDecodeError:
        content = plan.original.decode('cp949')
    rows = list(csv.reader(io.StringIO(content, newline='')))
    if not rows:
        raise MigrationError('비어 있는 CSV 파일입니다.')
    headers = rows[0]
    if any(len(row) > len(headers) for row in rows[1:]):
        raise MigrationError('헤더보다 데이터 열이 많은 CSV입니다. 열 이름을 먼저 정리해 주세요.')
    target = canonical_headers(headers)
    if target != headers:
        plan.change('CSV', '열 구조', headers, target, 'schema')
    result = [target]
    for index, row in enumerate(rows[1:], 2):
        if not any(not blank(v) for v in row):
            result.append(row)
            continue
        record = table_record(row, headers)
        before = copy.deepcopy(record)
        migrate_record(record, f'CSV!{index}', plan, tabular=True)
        out = [row[headers.index(h)] if h in headers and headers.index(h) < len(row) else '' for h in HEADERS]
        out += [row[i] if i < len(row) else '' for i, h in enumerate(headers) if h not in HEADERS]
        for key in FIELDS:
            if field_changed(key, before, record, tabular=True):
                out[target.index(LABELS[key])] = table_value(key, record.get(key))
        result.append(out)
    if not plan.changes:
        return plan.original
    stream = io.StringIO(newline='')
    csv.writer(stream, lineterminator='\r\n').writerows(result)
    return stream.getvalue().encode('utf-8-sig')


def migrate_json(plan):
    payload = json.loads(plan.original.decode('utf-8-sig'), parse_constant=lambda value: (_ for _ in ()).throw(MigrationError('유효하지 않은 JSON 숫자입니다.')))
    if isinstance(payload, list):
        rows = payload
    elif isinstance(payload, dict) and isinstance(payload.get('records'), list) and 'events' not in payload:
        rows = payload['records']
    elif isinstance(payload, dict) and isinstance(payload.get('events'), list) and 'records' not in payload:
        rows = payload['events']
    else:
        raise MigrationError('기록 배열, records 배열 또는 events 배열이 있는 JSON만 지원합니다.')
    for index, item in enumerate(rows, 1):
        if not isinstance(item, dict):
            raise MigrationError(f'JSON 기록 {index}가 객체가 아닙니다.')
        record = item.get('extendedProps', item)
        if not isinstance(record, dict) or 'title' not in record:
            raise MigrationError(f'JSON 기록 {index}에서 게임 제목을 찾지 못했습니다.')
        migrate_record(record, f'JSON!{index}', plan, item.get('id', ''))
        if record is not item and not blank(item.get('id')) and text(item['id']) != text(record['recordId']):
            plan.warn(f'JSON!{index}', '이벤트 ID와 기록 ID가 다릅니다. 두 ID를 보존했으니 확인해 주세요.')
    return (json.dumps(payload, ensure_ascii=False, indent=2, allow_nan=False) + '\n').encode('utf-8') if plan.changes else plan.original


def cell_value(cell, shared, date_styles, epoch1904=False):
    kind = cell.getAttribute('t')
    if kind == 'inlineStr':
        return ''.join(node_text(n) for n in elements(cell, 't'))
    values = children(cell, 'v')
    value = node_text(values[0]) if values else ''
    if kind == 's':
        try:
            return shared[int(value)]
        except (ValueError, IndexError):
            raise MigrationError('엑셀 공유 문자열 참조가 잘못되었습니다.')
    if kind == 'b':
        return value == '1'
    if kind in ('str', 'e', 'd'):
        return value
    if value and int(cell.getAttribute('s') or '0') in date_styles:
        try:
            base = dt.datetime(1904, 1, 1) if epoch1904 else dt.datetime(1899, 12, 30)
            return (base + dt.timedelta(days=float(value))).date().isoformat()
        except (ValueError, OverflowError):
            return value
    return value


def set_cell(cell, value):
    for node in list(cell.childNodes):
        if node.nodeType == node.ELEMENT_NODE and node.localName in ('v', 'is', 'f'):
            cell.removeChild(node)
    doc = cell.ownerDocument
    prefix = (cell.prefix + ':') if cell.prefix else ''
    if isinstance(value, (int, float)) and not isinstance(value, bool):
        cell.removeAttribute('t') if cell.hasAttribute('t') else None
        node = doc.createElementNS(NS, prefix + 'v')
        node.appendChild(doc.createTextNode(str(value)))
        cell.appendChild(node)
    else:
        cell.setAttribute('t', 'inlineStr')
        inline = doc.createElementNS(NS, prefix + 'is')
        node = doc.createElementNS(NS, prefix + 't')
        node.setAttribute('xml:space', 'preserve')
        node.appendChild(doc.createTextNode(str(value)))
        inline.appendChild(node)
        cell.appendChild(inline)


def migrate_xlsx(plan):
    try:
        archive = zipfile.ZipFile(io.BytesIO(plan.original))
    except zipfile.BadZipFile:
        raise MigrationError('올바른 .xlsx 파일이 아닙니다. 암호화된 파일은 암호를 해제해 주세요.')
    with archive:
        infos = archive.infolist()
        if len(infos) > 10000 or sum(x.file_size for x in infos) > MAX_BYTES:
            raise MigrationError('압축 해제 크기가 너무 큰 엑셀 파일입니다(최대 150MB).')
        names = [x.filename for x in infos]
        if len(set(names)) != len(names) or any(x.flag_bits & 1 for x in infos):
            raise MigrationError('중복 ZIP 항목 또는 암호화된 파일은 처리하지 않습니다.')
        parts = {x.filename: archive.read(x) for x in infos}
    if any(name.startswith('_xmlsignatures/') for name in names):
        raise MigrationError('서명된 엑셀은 서명이 깨질 수 있어 자동 수정하지 않습니다.')
    workbook = read_xml(parts['xl/workbook.xml'])
    rels = read_xml(parts['xl/_rels/workbook.xml.rels'])
    targets = {n.getAttribute('Id'): n.getAttribute('Target') for n in rels.documentElement.childNodes if n.nodeType == n.ELEMENT_NODE and n.getAttribute('TargetMode') != 'External'}
    shared = []
    if 'xl/sharedStrings.xml' in parts:
        strings = read_xml(parts['xl/sharedStrings.xml'])
        shared = [''.join(node_text(n) for n in elements(item, 't')) for item in elements(strings, 'si')]
    date_styles = set()
    if 'xl/styles.xml' in parts:
        styles = read_xml(parts['xl/styles.xml'])
        formats = {int(n.getAttribute('numFmtId')): n.getAttribute('formatCode') for n in elements(styles, 'numFmt')}
        xfs = elements(styles, 'cellXfs')
        if xfs:
            for index, xf in enumerate(children(xfs[0], 'xf')):
                fmt = int(xf.getAttribute('numFmtId') or '0')
                code = re.sub(r'"[^"]*"|\\.|\[[^\]]*\]', '', formats.get(fmt, '')).lower()
                if 14 <= fmt <= 22 or 27 <= fmt <= 36 or 50 <= fmt <= 58 or ('y' in code and ('d' in code or 'm' in code)):
                    date_styles.add(index)
    epoch = elements(workbook, 'workbookPr')
    epoch1904 = bool(epoch and epoch[0].getAttribute('date1904') in ('1', 'true'))
    sheets = []
    for sheet in elements(workbook, 'sheet'):
        target = targets.get(sheet.getAttributeNS(REL_NS, 'id'), '')
        name = posixpath.normpath(target.lstrip('/') if target.startswith('/') else posixpath.join('xl', target))
        if name not in parts:
            raise MigrationError('엑셀 시트 연결 정보를 찾지 못했습니다.')
        sheets.append((sheet.getAttribute('name'), name))
    year_sheets = [(name, part) for name, part in sheets if re.fullmatch(r'\d{4}', name)]
    candidates = year_sheets or [(name, part) for name, part in sheets if name not in ('게임 정리', '변경 기록', '변경기록')]
    any_formula = any(re.search(rb'<(?:[A-Za-z_][\w.-]*:)?f(?:\s|>)', data) for name, data in parts.items() if name.startswith('xl/') and name.endswith('.xml'))
    linked_ranges = bool(elements(workbook, 'definedName')) or any(name.startswith(('xl/charts/', 'xl/externalLinks/')) for name in names)
    replacements = {}
    for name, part in candidates:
        doc = read_xml(parts[part])
        sheet_data = elements(doc, 'sheetData')
        if not sheet_data:
            continue
        rows = children(sheet_data[0], 'row')
        header = next((r for r in rows if r.getAttribute('r') == '1'), None)
        if header is None:
            if (name, part) in year_sheets:
                plan.warn(name, '1행 헤더가 없어 이 연도 탭은 변경하지 않았습니다.')
            continue
        max_col = max((col_index(c.getAttribute('r')) for r in rows for c in children(r, 'c')), default=0)
        headers = [''] * max_col
        for cell in children(header, 'c'):
            headers[col_index(cell.getAttribute('r')) - 1] = str(cell_value(cell, shared, set()))
        if not all(label in headers for label in ('이름', '플랫폼', '시간')):
            if (name, part) in year_sheets:
                plan.warn(name, '게임 기록 헤더가 없어 이 연도 탭은 변경하지 않았습니다.')
            continue
        target_headers = canonical_headers(headers)
        mapping = {old + 1: (HEADERS.index(h) + 1 if h in HEADERS else len(HEADERS) + sum(1 for prev in headers[:old + 1] if prev not in HEADERS)) for old, h in enumerate(headers)}
        reordered = any(old != new for old, new in mapping.items())
        schema_change = target_headers != headers
        if reordered and (any_formula or linked_ranges):
            raise MigrationError(f'{name}: 열 이동이 필요하지만 통합 문서에 수식이 있습니다. 수식 참조를 보존하려면 값만 있는 기록 사본을 사용해 주세요.')
        if schema_change and (elements(doc, 'tableParts') or elements(doc, 'mergeCells')):
            raise MigrationError(f'{name}: 표 또는 병합 셀이 있어 자동 열 변경을 중단했습니다. 사이트에서 내보낸 원본 형식을 사용해 주세요.')
        if elements(doc, 'sheetProtection'):
            raise MigrationError(f'{name}: 보호된 시트는 수정하지 않습니다. 사본의 시트 보호를 먼저 해제해 주세요.')
        plan.sheets.append(name)
        count_before = len(plan.changes)
        if schema_change:
            plan.change(name, '열 구조', headers, target_headers, 'schema')
        prefix = (doc.documentElement.prefix + ':') if doc.documentElement.prefix else ''
        for row in rows:
            row_number = int(row.getAttribute('r'))
            cells = {col_index(c.getAttribute('r')): c for c in children(row, 'c')}
            values = [cell_value(cells[i], shared, date_styles, epoch1904) if i in cells else '' for i in range(1, len(headers) + 1)]
            if row_number != 1 and any(not blank(v) for v in values):
                if any(children(c, 'f') for c in cells.values()):
                    raise MigrationError(f'{name}!{row_number}: 기록 행에 수식이 있습니다. 값을 임의로 덮어쓰지 않았습니다.')
                record = table_record(values, headers)
                before = copy.deepcopy(record)
                migrate_record(record, f'{name}!{row_number}', plan, tabular=True)
            else:
                record = before = None
            if schema_change:
                for old, cell in cells.items():
                    cell.setAttribute('r', f'{col_name(mapping[old])}{row_number}')
                cells = {mapping[old]: cell for old, cell in cells.items()}
            changes = {}
            if row_number == 1 and schema_change:
                changes = dict(enumerate(target_headers, 1))
            elif record is not None:
                changes = {HEADERS.index(LABELS[k]) + 1: table_value(k, record.get(k)) for k in FIELDS if field_changed(k, before, record, tabular=True)}
            for column, value in changes.items():
                if column not in cells:
                    cells[column] = doc.createElementNS(NS, prefix + 'c')
                    cells[column].setAttribute('r', f'{col_name(column)}{row_number}')
                set_cell(cells[column], value)
            if schema_change or changes:
                for old_cell in children(row, 'c'):
                    row.removeChild(old_cell)
                anchor = next((n for n in row.childNodes if n.nodeType == n.ELEMENT_NODE), None)
                for _, cell in sorted(cells.items()):
                    row.insertBefore(cell, anchor)
                if row.hasAttribute('spans'):
                    row.setAttribute('spans', f'1:{len(target_headers)}')
        if len(plan.changes) > count_before:
            dims = elements(doc, 'dimension')
            if dims:
                dims[0].setAttribute('ref', f'A1:{col_name(len(target_headers))}{max(int(r.getAttribute("r")) for r in rows)}')
            if schema_change:
                for item in elements(doc, 'autoFilter'):
                    item.setAttribute('ref', f'A1:{col_name(len(target_headers))}{max(int(r.getAttribute("r")) for r in rows)}')
            replacements[part] = doc.toxml(encoding='utf-8')
    if not plan.sheets:
        raise MigrationError('변환할 게임 기록 탭을 찾지 못했습니다. 게임 정리 탭이 아닌 연도별 원본 탭이 필요합니다.')
    if not replacements:
        return plan.original
    result = io.BytesIO()
    with zipfile.ZipFile(result, 'w') as output:
        for info in infos:
            output.writestr(info, replacements.get(info.filename, parts[info.filename]))
    # Verify the generated package is readable before offering it for saving.
    with zipfile.ZipFile(io.BytesIO(result.getvalue())) as check:
        if check.testzip():
            raise MigrationError('결과 파일 검증에 실패했습니다.')
    return result.getvalue()


def inspect_file(path):
    source = Path(path).resolve()
    if source.suffix.lower() not in ('.xlsx', '.csv', '.json'):
        raise MigrationError('.xlsx, .csv, .json 파일만 지원합니다. .xls는 .xlsx로 저장해 주세요.')
    if source.stat().st_size > MAX_BYTES:
        raise MigrationError('파일 크기는 최대 150MB까지 지원합니다.')
    unknown = set(RELEASE['migrations']) - MIGRATION_REGISTRY.keys()
    if unknown:
        raise MigrationError('도구의 변환 규칙이 누락되었습니다. 도구 폴더 전체를 다시 받아 주세요.')
    plan = Plan(source, source.read_bytes())
    plan.converted = {'.xlsx': migrate_xlsx, '.csv': migrate_csv, '.json': migrate_json}[source.suffix.lower()](plan)
    return plan


def save_plan(plan, output_dir):
    # Never save a stale preview after the user or another app changes the input.
    if plan.source.read_bytes() != plan.original:
        raise MigrationError('검사 후 원본 파일이 변경되었습니다. 다시 검사해 주세요.')
    base = Path(output_dir).resolve()
    base.mkdir(parents=True, exist_ok=True)
    folder = base / (dt.datetime.now().strftime('%Y%m%d-%H%M%S') + '-' + uuid.uuid4().hex[:8])
    folder.mkdir()
    try:
        backup = folder / ('원본백업' + plan.source.suffix.lower())
        converted = folder / (plan.source.stem + '-v' + RELEASE['targetSiteVersion'] + plan.source.suffix.lower())
        backup.write_bytes(plan.original)
        converted.write_bytes(plan.converted)
        report = plan.report()
        (folder / '변경내역.json').write_text(json.dumps(report, ensure_ascii=False, indent=2, default=str) + '\n', encoding='utf-8')
        lines = [f"Game Effect 데이터 업데이트 → v{RELEASE['targetSiteVersion']}", report['status'],
                 f"기록 {plan.records}개 / 변경 {len(plan.changes)}건 / 확인 {len(plan.warnings)}건",
                 '날짜·시간·제목·한줄평·기존 게임 ID는 보존합니다. 행 삭제·합산·누적시간 재해석은 하지 않습니다.',
                 '이 파일은 로컬 사본입니다. 사이트 또는 구글 시트에 자동 반영되지 않습니다.',
                 '원본의 사이트 버전은 파일에 없어 확정하지 않으며, 현재 열 구조와 등록된 규칙으로 검사합니다.', '']
        for change in plan.changes:
            lines.append(f"[변경] {change['location']} / {change['field']}: {change['before']} → {change['after']}")
        for warning in plan.warnings:
            lines.append(f"[확인] {warning['location']} / {warning['message']}")
        (folder / '먼저읽기.txt').write_text('\n'.join(lines), encoding='utf-8-sig')
        if backup.read_bytes() != plan.original or converted.read_bytes() != plan.converted:
            raise MigrationError('저장한 파일 검증에 실패했습니다.')
    except Exception:
        # Keep any completed backup; never remove user data during error recovery.
        raise MigrationError(f'결과 저장을 완료하지 못했습니다. 저장 폴더를 확인해 주세요: {folder}')
    return folder, converted


def check_release(workspace=None):
    workspace = Path(workspace) if workspace else ROOT.parent
    html = (workspace / 'index.html').read_text(encoding='utf-8')
    sheet = (workspace / 'sheet.js').read_text(encoding='utf-8')
    version = re.search(r'class="app-version">v([^<]+)', html)
    headers = re.search(r'const SPREADSHEET_HEADERS = (\[[^;]+\]);', sheet)
    if not version or version[1] != RELEASE['targetSiteVersion']:
        raise MigrationError('사이트 버전과 도구의 대상 버전이 다릅니다. release.json과 변환 규칙을 함께 업데이트해 주세요.')
    if not headers or json.loads(headers[1].replace("'", '"')) != HEADERS:
        raise MigrationError('사이트와 도구의 열 구조가 다릅니다. 변환 규칙을 업데이트해 주세요.')
    if set(RELEASE['migrations']) - MIGRATION_REGISTRY.keys():
        raise MigrationError('릴리스에 필요한 변환 규칙이 누락되었습니다.')
    return f"사이트 v{version[1]} / 데이터 형식 {RELEASE['schemaRevision']} 일치"
