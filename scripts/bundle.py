#!/usr/bin/env python3
"""Concatenates the Apps Script modules into a single paste-ready file.

The Apps Script editor needs a file created per module by hand, which is eight
manual steps. This produces dist/Code.gs so installation is one paste instead.

Usage:  python3 scripts/bundle.py
"""

import os

# Load order matters: Config defines CONFIG, which the rest read at call time.
MODULES = ['Config', 'Statuses', 'Log', 'Sheets', 'Surense', 'Notify',
           'Main', 'Mirror', 'Diff', 'Diagnose', 'Triggers']

HEADER = """/**
 * אוטומציית התראות על שינוי סטטוס ליד — Surense CRM
 *
 * כל הקוד בקובץ אחד, להעתקה יחידה לעורך Apps Script.
 * נוצר אוטומטית מתוך apps-script/*.gs — אל תערוך כאן.
 * לעריכה: שנה את המקור ב-repo והרץ scripts/bundle.py.
 *
 * התקנה:
 *   1. הדבק את כל הקובץ הזה לתוך Code.gs
 *   2. Project Settings -> Show appsscript.json, והדבק את התוכן מה-repo
 *   3. Project Settings -> Script Properties:
 *        SURENSE_CLIENT_ID      = cid_NpUMsHGD80q0izlhEQnfoA
 *        SURENSE_CLIENT_SECRET  = הסוד אחרי סיבוב
 *   4. מלא את CONFIG.operatorEmail למטה
 *   5. הרץ checkSetup() ואז dryRun()
 */

"""


def main():
    root = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
    src = os.path.join(root, 'apps-script')
    dist = os.path.join(root, 'dist')

    os.makedirs(dist, exist_ok=True)
    parts = [HEADER]

    for name in MODULES:
        with open(os.path.join(src, name + '.gs'), encoding='utf-8') as handle:
            body = handle.read().strip()

        rule = '// ' + '=' * 70
        parts.append('%s\n// %s.gs\n%s\n\n%s\n\n\n' % (rule, name, rule, body))

    target = os.path.join(dist, 'Code.gs')

    with open(target, 'w', encoding='utf-8') as handle:
        handle.write(''.join(parts).rstrip() + '\n')

    print('Wrote %s (%d modules, %d lines)' % (
        os.path.relpath(target, root), len(MODULES),
        sum(1 for _ in open(target, encoding='utf-8'))))


if __name__ == '__main__':
    main()
