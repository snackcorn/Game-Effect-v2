import csv
import hashlib
import io
import json
import sys
import tempfile
import unittest
import zipfile
from pathlib import Path
from xml.etree import ElementTree as ET
from xml.sax.saxutils import escape

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))
from migrator import HEADERS, FIELDS, NS, MigrationError, check_release, col_name, inspect_file, save_plan


def xml_cell(column, row, value, style=''):
    reference = f'{col_name(column)}{row}'
    if isinstance(value, (int, float)):
        return f'<c r="{reference}"{style}><v>{value}</v></c>'
    return f'<c r="{reference}" t="inlineStr"{style}><is><t xml:space="preserve">{escape(str(value))}</t></is></c>'


def workbook(headers, records, extra_parts=None, formula=False, summary_formula=False, date_cell=False, extra_sheet=False):
    rows = ['<row r="1">' + ''.join(xml_cell(i, 1, value) for i, value in enumerate(headers, 1)) + '</row>']
    for index, record in enumerate(records, 2):
        cells = []
        for column, value in enumerate(record, 1):
            if formula and column == 5:
                cells.append(f'<c r="E{index}"><f>1+1</f><v>2</v></c>')
            else:
                cells.append(xml_cell(column, index, value, ' s="1"' if date_cell and column in (2, 3) else ''))
        rows.append(f'<row r="{index}">' + ''.join(cells) + '</row>')
    worksheet = f'<?xml version="1.0" encoding="UTF-8"?><worksheet xmlns="{NS}" xmlns:mc="http://schemas.openxmlformats.org/markup-compatibility/2006" xmlns:x14ac="http://schemas.microsoft.com/office/spreadsheetml/2009/9/ac" mc:Ignorable="x14ac"><dimension ref="A1:P4"/><sheetData>' + ''.join(rows) + '</sheetData></worksheet>'
    parts = {
        '[Content_Types].xml': f'<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"><Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/><Default Extension="xml" ContentType="application/xml"/><Override PartName="/xl/workbook.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.sheet.main+xml"/><Override PartName="/xl/worksheets/sheet1.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.worksheet+xml"/></Types>',
        '_rels/.rels': '<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="r1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="xl/workbook.xml"/></Relationships>',
        'xl/workbook.xml': f'<workbook xmlns="{NS}" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships"><sheets><sheet name="2026" sheetId="1" r:id="r1"/><sheet name="게임 정리" sheetId="2" r:id="r2"/>' + ('<sheet name="2025" sheetId="3" r:id="r3"/>' if extra_sheet else '') + '</sheets></workbook>',
        'xl/_rels/workbook.xml.rels': '<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="r1" Target="worksheets/sheet1.xml"/><Relationship Id="r2" Target="worksheets/sheet2.xml"/>' + ('<Relationship Id="r3" Target="worksheets/sheet3.xml"/>' if extra_sheet else '') + '</Relationships>',
        'xl/worksheets/sheet1.xml': worksheet,
        'xl/worksheets/sheet2.xml': f'<worksheet xmlns="{NS}"><sheetData><row r="1"><c r="A1" t="inlineStr"><is><t>그대로 보존</t></is></c>' + ('<c r="B1"><f>SUM(\'2026\'!E2:E3)</f><v>2</v></c>' if summary_formula else '') + '</row></sheetData></worksheet>',
        'xl/styles.xml': f'<styleSheet xmlns="{NS}"><cellXfs count="2"><xf numFmtId="0"/><xf numFmtId="14"/></cellXfs></styleSheet>',
        'xl/media/preserved.bin': b'preserve unrelated binary part\x00\x01',
    }
    if extra_sheet:
        parts['xl/worksheets/sheet3.xml'] = worksheet
    parts.update(extra_parts or {})
    stream = io.BytesIO()
    with zipfile.ZipFile(stream, 'w', zipfile.ZIP_DEFLATED) as archive:
        for name, content in parts.items():
            archive.writestr(name, content)
    return stream.getvalue()


def read_values(data, part='xl/worksheets/sheet1.xml'):
    with zipfile.ZipFile(io.BytesIO(data)) as archive:
        root = ET.fromstring(archive.read(part))
        strings = []
        if 'xl/sharedStrings.xml' in archive.namelist():
            strings = [''.join(node.itertext()) for node in ET.fromstring(archive.read('xl/sharedStrings.xml')).findall('{%s}si' % NS)]
        result = {}
        for cell in root.findall('.//{%s}c' % NS):
            inline = cell.find('{%s}is' % NS)
            value = cell.find('{%s}v' % NS)
            raw = ''.join(inline.itertext()) if inline is not None else (value.text or '' if value is not None else '')
            result[cell.attrib['r']] = strings[int(raw)] if cell.attrib.get('t') == 's' else raw
        return result


class Migrations(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.addCleanup(self.temp.cleanup)
        self.folder = Path(self.temp.name)

    def file(self, name, content):
        target = self.folder / name
        target.write_bytes(content)
        return target

    def csv_file(self, rows):
        data = io.StringIO(newline='')
        csv.writer(data).writerows(rows)
        return self.file('synthetic.csv', data.getvalue().encode('utf-8-sig'))

    def record(self, **extra):
        record = dict(zip(FIELDS, ['Synthetic Game', '2026-11-01', '2026-11-02', 'steam', 2, 'x', 'memo', 'review', '100', '', 'existing-id', 120, '', '', '', '']))
        record.update(extra)
        return record

    def values(self, record):
        return [record[key] for key in FIELDS]

    def test_release_matches_site(self):
        self.assertIn('2.74', check_release())

    def test_release_guard_detects_drift(self):
        (self.folder / 'index.html').write_text('<span class="app-version">v9.99</span>', encoding='utf-8')
        (self.folder / 'sheet.js').write_text('', encoding='utf-8')
        with self.assertRaisesRegex(MigrationError, '버전'):
            check_release(self.folder)

    def test_current_xlsx_is_byte_identical(self):
        content = workbook(HEADERS, [self.values(self.record())])
        plan = inspect_file(self.file('current.xlsx', content))
        self.assertEqual(plan.changes, [])
        self.assertEqual(plan.warnings, [])
        self.assertEqual(plan.converted, content)

    def test_legacy_xlsx_appends_headers_and_preserves_gameplay(self):
        record = self.record(time=38.4, review='한줄평\n& <보존>')
        source = self.file('old.xlsx', workbook(HEADERS[:10], [self.values(record)[:10]]))
        original = source.read_bytes()
        plan = inspect_file(source)
        out = read_values(plan.converted)
        self.assertEqual(out['E2'], '38.4')
        self.assertEqual(out['H2'], '한줄평\n& <보존>')
        self.assertTrue(out['K2'].startswith('rec_'))
        self.assertEqual(out['L2'], '2304')
        self.assertEqual(out['P1'], HEADERS[-1])
        self.assertEqual(source.read_bytes(), original)
        with zipfile.ZipFile(io.BytesIO(original)) as before, zipfile.ZipFile(io.BytesIO(plan.converted)) as after:
            for name in before.namelist():
                if name != 'xl/worksheets/sheet1.xml':
                    self.assertEqual(before.read(name), after.read(name), name)
            self.assertIn(b'xmlns:x14ac=', after.read('xl/worksheets/sheet1.xml'))
            self.assertIn(b'mc:Ignorable="x14ac"', after.read('xl/worksheets/sheet1.xml'))

    def test_xlsx_round_trip_is_idempotent(self):
        source = self.file('old.xlsx', workbook(HEADERS[:10], [self.values(self.record())[:10]]))
        first = inspect_file(source)
        second = inspect_file(self.file('converted.xlsx', first.converted))
        self.assertEqual(second.changes, [])
        self.assertEqual(second.converted, first.converted)
        self.assertEqual(inspect_file(source).converted, first.converted)

    def test_excel_date_cells_and_shared_strings_remain_intact(self):
        xml = f'<worksheet xmlns="{NS}"><sheetData><row r="1">' + ''.join(xml_cell(i, 1, h) for i, h in enumerate(HEADERS[:10], 1)) + '</row><row r="2"><c r="A2" t="s"><v>0</v></c><c r="B2" s="1"><v>46343</v></c><c r="D2" t="inlineStr"><is><t>steam</t></is></c><c r="E2"><v>4.6</v></c></row></sheetData></worksheet>'
        content = workbook(HEADERS, [], extra_parts={'xl/worksheets/sheet1.xml': xml, 'xl/sharedStrings.xml': f'<sst xmlns="{NS}"><si><t>Synthetic Legacy Edition</t></si></sst>'})
        plan = inspect_file(self.file('date.xlsx', content))
        cells = read_values(plan.converted)
        self.assertEqual(cells['A2'], 'Synthetic Legacy Edition')
        self.assertEqual(cells['B2'], '46343')
        self.assertEqual(cells['L2'], '276')
        self.assertFalse(any('날짜' in w['message'] or '형식' in w['message'] for w in plan.warnings))

    def test_minutes_are_derived_from_hours_not_steam_total(self):
        record = self.record(time=3.5, steamTotal=1500, playtimeMinutes=999)
        plan = inspect_file(self.csv_file([HEADERS, self.values(record)]))
        rows = list(csv.reader(io.StringIO(plan.converted.decode('utf-8-sig'))))
        self.assertEqual(rows[1][4], '3.5')
        self.assertEqual(rows[1][9], '1500')
        self.assertEqual(rows[1][11], '210')

    def test_zero_hours_is_valid_and_missing_time_is_not_zeroed(self):
        for value in (0, '', 'unknown', '-2'):
            with self.subTest(value=value):
                plan = inspect_file(self.csv_file([HEADERS, self.values(self.record(time=value, playtimeMinutes=''))]))
                rows = list(csv.reader(io.StringIO(plan.converted.decode('utf-8-sig'))))
                self.assertEqual(rows[1][4], str(value))
                self.assertEqual(rows[1][11], '0' if value == 0 else '')
                self.assertEqual(bool(plan.warnings), value != 0)

    def test_duplicate_records_preserved_not_merged(self):
        record = self.record()
        plan = inspect_file(self.file('dupe.xlsx', workbook(HEADERS, [self.values(record), self.values(record)])))
        out = read_values(plan.converted)
        self.assertEqual(out['K2'], out['K3'])
        self.assertEqual(plan.records, 2)
        self.assertTrue(any('기록 ID' in item['message'] for item in plan.warnings))
        self.assertTrue(any('내용이' in item['message'] for item in plan.warnings))

    def test_launcher_classification_and_ids_never_guessed(self):
        record = self.record(steamAppId='100', parentAppId='200', launcherChildAppId='300', isLauncherAllocation='', time=4.6)
        plan = inspect_file(self.csv_file([HEADERS, self.values(record)]))
        rows = list(csv.reader(io.StringIO(plan.converted.decode('utf-8-sig'))))
        self.assertEqual([rows[1][i] for i in (8, 12, 15)], ['100', '200', '300'])
        self.assertEqual(rows[1][13], 'Y')
        self.assertTrue(any('다릅니다' in w['message'] for w in plan.warnings))

    def test_false_table_flag_is_preserved_without_unreported_change(self):
        record = self.record(isLauncherAllocation='N', recordId='')
        plan = inspect_file(self.csv_file([HEADERS, self.values(record)]))
        rows = list(csv.reader(io.StringIO(plan.converted.decode('utf-8-sig'))))
        self.assertEqual(rows[1][13], 'N')
        self.assertFalse(any(c['field'] == '런처 배분 기록' for c in plan.changes))

    def test_unknown_and_multiple_unnamed_columns_preserved(self):
        headers = HEADERS[:10] + ['extra', '', '']
        record = self.values(self.record())[:10] + ['keep extra', 'keep blank one', 'keep blank two']
        for suffix, source in [('csv', None), ('xlsx', workbook(headers, [record]))]:
            plan = inspect_file(self.csv_file([headers, record]) if suffix == 'csv' else self.file('unknown.xlsx', source))
            if suffix == 'csv':
                rows = list(csv.reader(io.StringIO(plan.converted.decode('utf-8-sig'))))
                self.assertEqual(rows[1][-3:], record[-3:])
            else:
                cells = read_values(plan.converted)
                self.assertEqual([cells['Q2'], cells['R2'], cells['S2']], record[-3:])

    def test_csv_round_trip_and_cp949(self):
        source = self.csv_file([HEADERS[:10], self.values(self.record())[:10]])
        cp949 = self.file('cp949.csv', source.read_bytes().decode('utf-8-sig').encode('cp949'))
        plan = inspect_file(cp949)
        second = inspect_file(self.file('second.csv', plan.converted))
        self.assertEqual(second.changes, [])
        self.assertEqual(second.converted, plan.converted)

    def test_json_event_uses_existing_event_id_preserving_extra_fields(self):
        record = self.record()
        record.pop('recordId')
        payload = {'events': [{'id': 'event-id', 'extendedProps': record, 'display': 'keep'}], 'custom': {'value': 'preserve'}}
        plan = inspect_file(self.file('data.json', json.dumps(payload).encode()))
        after = json.loads(plan.converted)
        self.assertEqual(after['events'][0]['extendedProps']['recordId'], 'event-id')
        self.assertEqual(after['events'][0]['display'], 'keep')
        self.assertEqual(after['custom'], payload['custom'])
        self.assertEqual(after['events'][0]['extendedProps']['time'], 2)
        repeat = inspect_file(self.file('repeat.json', plan.converted))
        self.assertEqual(repeat.changes, [])
        self.assertEqual(repeat.converted, plan.converted)

    def test_json_invalid_shape_and_nan_refused(self):
        for content in (b'{"token":"not-record-data"}', b'[NaN]', b'{"records":[],"events":[]}'):
            with self.subTest(content=content), self.assertRaises(MigrationError):
                inspect_file(self.file('bad.json', content))

    def test_save_creates_verified_backup_and_unique_folder(self):
        source = self.csv_file([HEADERS[:10], self.values(self.record())[:10]])
        original = source.read_bytes()
        plan = inspect_file(source)
        folder, output = save_plan(plan, self.folder / 'results')
        next_folder, _ = save_plan(plan, self.folder / 'results')
        self.assertNotEqual(folder, next_folder)
        self.assertEqual((folder / '원본백업.csv').read_bytes(), original)
        self.assertEqual(source.read_bytes(), original)
        self.assertEqual(output.read_bytes(), plan.converted)
        report = json.loads((folder / '변경내역.json').read_text(encoding='utf-8'))
        self.assertEqual(report['sourceSha256'], hashlib.sha256(original).hexdigest())
        self.assertEqual(report['targetSiteVersion'], '2.74')
        self.assertTrue((folder / '먼저읽기.txt').exists())

    def test_stale_preview_cannot_save(self):
        source = self.csv_file([HEADERS, self.values(self.record())])
        plan = inspect_file(source)
        source.write_bytes(source.read_bytes() + b'\r\n')
        with self.assertRaisesRegex(MigrationError, '변경'):
            save_plan(plan, self.folder / 'results')
        self.assertFalse((self.folder / 'results').exists())

    def test_record_formula_not_overwritten(self):
        source = self.file('formula.xlsx', workbook(HEADERS[:10], [self.values(self.record())[:10]], formula=True))
        original = source.read_bytes()
        with self.assertRaisesRegex(MigrationError, '수식'):
            inspect_file(source)
        self.assertEqual(source.read_bytes(), original)

    def test_formula_refs_block_column_shift_but_allow_safe_append(self):
        record = self.values(self.record())[:10]
        safe = self.file('safe.xlsx', workbook(HEADERS[:10], [record], summary_formula=True))
        self.assertTrue(inspect_file(safe).changes)
        unsafe = self.file('unsafe.xlsx', workbook(HEADERS[:10] + ['custom'], [record + ['value']], summary_formula=True))
        with self.assertRaisesRegex(MigrationError, '열 이동'):
            inspect_file(unsafe)

    def test_duplicate_headers_and_extra_csv_fields_are_refused(self):
        for rows in ([HEADERS[:10] + ['이름'], self.values(self.record())[:10] + ['x']], [HEADERS[:10], self.values(self.record())]):
            with self.assertRaises(MigrationError):
                inspect_file(self.csv_file(rows))

    def test_cross_year_duplicate_ids_are_reported(self):
        plan = inspect_file(self.file('years.xlsx', workbook(HEADERS, [self.values(self.record())], extra_sheet=True)))
        self.assertEqual(plan.records, 2)
        self.assertEqual(plan.sheets, ['2026', '2025'])
        self.assertTrue(any('중복' in w['message'] for w in plan.warnings))

    def test_ambiguous_dates_and_precision_are_reported_not_rewritten(self):
        record = self.record(startDate='20261101', endDate='2026-02-30', time=1.33333333)
        plan = inspect_file(self.csv_file([HEADERS, self.values(record)]))
        out = list(csv.reader(io.StringIO(plan.converted.decode('utf-8-sig'))))[1]
        self.assertEqual(out[1:3], ['20261101', '2026-02-30'])
        self.assertEqual(out[4], '1.33333333')
        self.assertGreaterEqual(len(plan.warnings), 3)

    def test_invalid_xlsx_and_unsupported_extension_refused(self):
        for name, content in [('bad.xlsx', b'not a zip'), ('old.xls', b'not an xlsx')]:
            with self.subTest(name=name), self.assertRaises(MigrationError):
                inspect_file(self.file(name, content))


if __name__ == '__main__':
    unittest.main()
