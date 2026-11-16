"""Windows desktop entry point; GUI by default, CLI for repeatable verification."""
import argparse
import json
import os
import queue
import sys
import threading
from pathlib import Path

sys.dont_write_bytecode = True
from migrator import RELEASE, ROOT, check_release, inspect_file, save_plan


def launch_gui(initial=''):
    import tkinter as tk
    from tkinter import filedialog, messagebox, ttk

    root = tk.Tk()
    root.title(f"Game Effect 데이터 업데이트 · v{RELEASE['targetSiteVersion']}")
    root.geometry('980x720')
    root.minsize(780, 580)
    style = ttk.Style(root)
    if 'vista' in style.theme_names():
        style.theme_use('vista')
    style.configure('Title.TLabel', font=('맑은 고딕', 18, 'bold'))
    style.configure('TLabel', font=('맑은 고딕', 10))
    style.configure('TButton', font=('맑은 고딕', 10), padding=7)
    style.configure('Treeview', rowheight=28, font=('맑은 고딕', 9))

    outer = ttk.Frame(root, padding=22)
    outer.pack(fill='both', expand=True)
    ttk.Label(outer, text='Game Effect 데이터 업데이트', style='Title.TLabel').pack(anchor='w')
    ttk.Label(outer, text=f"사이트 v{RELEASE['targetSiteVersion']}에 맞게 검사합니다. 인터넷 연결 없이 원본을 보존합니다.").pack(anchor='w', pady=(6, 20))

    file_path = tk.StringVar(value=initial)
    output_path = tk.StringVar(value=str(ROOT.parent / '.local-only' / 'data-updates'))
    state = {'plan': None, 'busy': False, 'folder': None}
    jobs = queue.Queue()

    def set_busy(value):
        state['busy'] = value
        choose.configure(state='disabled' if value else 'normal')
        inspect_button.configure(state='disabled' if value else 'normal')
        save_button.configure(state='normal' if state['plan'] is not None and not value else 'disabled')
        if value:
            progress.start(12)
        else:
            progress.stop()

    def background(fn):
        def work():
            try:
                jobs.put(('ok', fn()))
            except Exception as error:
                jobs.put(('error', str(error)))
        set_busy(True)
        threading.Thread(target=work, daemon=True).start()

    def inspect():
        if state['busy']:
            return
        if not file_path.get():
            messagebox.showinfo('파일 선택', '현재 쓰는 연동용 데이터 파일을 먼저 선택해 주세요.', parent=root)
            return
        state['plan'] = None
        state['folder'] = None
        open_button.configure(state='disabled')
        changes.delete(*changes.get_children())
        warnings.delete(*warnings.get_children())
        status.set('파일 검사 중…')
        selected = file_path.get()
        background(lambda: ('inspect', inspect_file(selected)))

    def choose_file():
        selected = filedialog.askopenfilename(title='현재 사용하는 데이터 선택', filetypes=[('게임 데이터', '*.xlsx *.csv *.json'), ('Excel', '*.xlsx'), ('CSV', '*.csv'), ('JSON', '*.json')])
        if selected:
            file_path.set(selected)
            inspect()

    def choose_output():
        selected = filedialog.askdirectory(title='백업·변환 사본 저장 위치 선택', initialdir=str(ROOT.parent))
        if selected:
            output_path.set(selected)

    def save():
        if state['busy'] or state['plan'] is None:
            return
        plan = state['plan']
        if plan.warnings and not messagebox.askyesno('확인할 항목이 있습니다', f'확인할 항목이 {len(plan.warnings)}건 있습니다.\n추측하지 않고 해당 값을 보존한 사본과 보고서를 저장할까요?\n\n시트나 사이트에는 자동 반영하지 않습니다.', parent=root):
            return
        selected_output = output_path.get()
        status.set('원본 백업과 변환 사본 저장 중…')
        background(lambda: ('save', save_plan(plan, selected_output)))

    def open_folder():
        if state['folder']:
            os.startfile(str(state['folder']))

    file_row = ttk.Frame(outer)
    file_row.pack(fill='x')
    ttk.Label(file_row, text='현재 데이터').pack(side='left', padx=(0, 12))
    ttk.Entry(file_row, textvariable=file_path, state='readonly').pack(side='left', fill='x', expand=True)
    choose = ttk.Button(file_row, text='파일 선택', command=choose_file)
    choose.pack(side='left', padx=(8, 0))
    inspect_button = ttk.Button(file_row, text='다시 검사', command=inspect)
    inspect_button.pack(side='left', padx=(8, 0))
    out_row = ttk.Frame(outer)
    out_row.pack(fill='x', pady=(10, 14))
    ttk.Label(out_row, text='결과 폴더  ').pack(side='left', padx=(0, 12))
    ttk.Entry(out_row, textvariable=output_path, state='readonly').pack(side='left', fill='x', expand=True)
    ttk.Button(out_row, text='위치 변경', command=choose_output).pack(side='left', padx=(8, 0))
    ttk.Label(outer, text='① 파일 선택 → ② 변경 예정·확인 사항 검토 → ③ 백업과 사본 저장').pack(anchor='w', pady=(0, 10))

    status = tk.StringVar(value='현재 연결된 시트를 Excel(.xlsx)로 내려받은 파일을 선택해 주세요.')
    ttk.Label(outer, textvariable=status, wraplength=900).pack(anchor='w', pady=(0, 8))
    progress = ttk.Progressbar(outer, mode='indeterminate')
    progress.pack(fill='x', pady=(0, 14))
    tabs = ttk.Notebook(outer)
    tabs.pack(fill='both', expand=True)

    def make_table(title, columns):
        frame = ttk.Frame(tabs)
        tabs.add(frame, text=title)
        table = ttk.Treeview(frame, columns=[key for key, _, _ in columns], show='headings')
        vertical = ttk.Scrollbar(frame, orient='vertical', command=table.yview)
        horizontal = ttk.Scrollbar(frame, orient='horizontal', command=table.xview)
        table.configure(yscrollcommand=vertical.set, xscrollcommand=horizontal.set)
        table.grid(row=0, column=0, sticky='nsew')
        vertical.grid(row=0, column=1, sticky='ns')
        horizontal.grid(row=1, column=0, sticky='ew')
        frame.rowconfigure(0, weight=1)
        frame.columnconfigure(0, weight=1)
        for key, label, width in columns:
            table.heading(key, text=label)
            table.column(key, width=width, minwidth=80)
        return table

    changes = make_table('변경 예정', [('location', '위치', 130), ('field', '항목', 150), ('before', '기존 값', 240), ('after', '변경 값', 260)])
    warnings = make_table('확인 사항', [('location', '위치', 130), ('message', '보존한 값·확인이 필요한 이유', 690)])

    footer = ttk.Frame(outer)
    footer.pack(side='bottom', fill='x', before=tabs)
    footer_note = ttk.Label(footer, text='게임 기록 행을 삭제·합산하지 않습니다. 날짜·플레이 시간·제목·한줄평·기존 게임 ID를 보존합니다.\n변환 사본·백업·보고서는 개인 데이터입니다. GitHub에 업로드하지 마세요.', wraplength=900)
    footer_note.pack(anchor='w', pady=(14, 10))
    footer.bind('<Configure>', lambda event: footer_note.configure(wraplength=max(400, event.width)))
    buttons = ttk.Frame(footer)
    buttons.pack(fill='x')
    open_button = ttk.Button(buttons, text='결과 폴더 열기', command=open_folder, state='disabled')
    open_button.pack(side='left')
    save_button = ttk.Button(buttons, text='원본 백업 + 변환 사본 저장', command=save, state='disabled')
    save_button.pack(side='right')

    def poll():
        try:
            kind, result = jobs.get_nowait()
        except queue.Empty:
            root.after(100, poll)
            return
        set_busy(False)
        if kind == 'error':
            status.set('작업을 완료하지 못했습니다. 원본 파일은 변경하지 않았습니다.')
            messagebox.showerror('처리 중단', result, parent=root)
        elif result[0] == 'inspect':
            plan = result[1]
            state['plan'] = plan
            report = plan.report()
            preview_status = '확인 필요' if plan.warnings else ('변환 예정' if plan.changes else '변환할 내용 없음')
            status.set(f"{preview_status} · 기록 {plan.records:,}개 / 변경 {len(plan.changes):,}건 / 확인 {len(plan.warnings):,}건")
            for item in plan.changes[:2000]:
                changes.insert('', 'end', values=[str(item.get(key, ''))[:400] for key in ('location', 'field', 'before', 'after')])
            for item in plan.warnings[:2000]:
                warnings.insert('', 'end', values=[item['location'], item['message']])
            if len(plan.changes) > 2000 or len(plan.warnings) > 2000:
                status.set(status.get() + ' · 화면은 항목별 첫 2,000건, 보고서는 전체 포함')
            save_button.configure(state='normal')
        else:
            folder, converted = result[1]
            state['folder'] = folder
            status.set(f'저장 완료: {converted.name} · 사이트·구글 시트에는 아직 반영되지 않았습니다.')
            open_button.configure(state='normal')
            messagebox.showinfo('저장 완료', f'원본 백업·변환 사본·변경 보고서를 저장했습니다.\n\n{folder}\n\n먼저읽기.txt를 확인한 후 사본을 사용해 주세요.', parent=root)
        root.after(100, poll)

    def on_close():
        if state['busy'] and not messagebox.askyesno('작업 진행 중', '진행 중인 작업이 있습니다. 창을 닫을까요? 저장 중이면 일부 결과만 남을 수 있습니다.', parent=root):
            return
        root.destroy()

    root.protocol('WM_DELETE_WINDOW', on_close)
    root.after(100, poll)
    if initial:
        root.after(200, inspect)
    root.mainloop()


def main():
    parser = argparse.ArgumentParser(description='Game Effect 로컬 데이터 업데이트')
    parser.add_argument('file', nargs='?', help='미리 선택할 데이터 파일')
    parser.add_argument('--inspect', metavar='FILE', help='파일 검사 후 JSON 보고서 출력')
    parser.add_argument('--convert', metavar='FILE', help='검사 후 원본 백업·변환 사본 저장')
    parser.add_argument('--output-dir', default=str(ROOT.parent / '.local-only' / 'data-updates'))
    parser.add_argument('--check-release', action='store_true', help='사이트 버전·열 구조와 도구가 일치하는지 확인')
    args = parser.parse_args()
    try:
        if args.check_release:
            print(check_release())
        elif args.inspect:
            print(json.dumps(inspect_file(args.inspect).report(), ensure_ascii=False, indent=2, default=str))
        elif args.convert:
            folder, converted = save_plan(inspect_file(args.convert), args.output_dir)
            print(json.dumps({'folder': str(folder), 'converted': str(converted)}, ensure_ascii=False))
        else:
            launch_gui(args.file or '')
    except Exception as error:
        if args.check_release or args.inspect or args.convert:
            parser.exit(1, f'{error}\n')
        import tkinter as tk
        from tkinter import messagebox
        root = tk.Tk()
        root.withdraw()
        messagebox.showerror('실행 오류', str(error), parent=root)
        root.destroy()


if __name__ == '__main__':
    main()
