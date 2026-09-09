"""Rebase live path fields after moving the home; keep historical evidence intact.

Run with the workstation closed. The C:\\sovereign compatibility junction must
already target C:\\zeroD. A SQLite backup is retained before the transaction.
"""
import json
import sqlite3
from datetime import datetime
from pathlib import Path


def rebase(value):
    if isinstance(value, str):
        normalized = value.replace('\\', '/')
        if normalized.lower() == 'c:/sovereign' or normalized.lower().startswith('c:/sovereign/'):
            return 'C:/zeroD' + normalized[len('c:/sovereign'):]
    elif isinstance(value, list):
        return [rebase(item) for item in value]
    elif isinstance(value, dict):
        return {key: rebase(item) for key, item in value.items()}
    return value


def main():
    home = Path('C:/zeroD')
    assert home.samefile('C:/sovereign'), 'Compatibility junction must target zeroD'
    db = home / 'state/workbench.db'
    assert db.is_file(), 'Existing canonical database is required'
    connection = sqlite3.connect(db, timeout=2)
    backup = db.with_name('workbench.before-zeroD-' + datetime.now().strftime('%Y%m%d-%H%M%S') + '.db')
    with sqlite3.connect(backup) as target:
        connection.backup(target)
    with connection:
        connection.execute('BEGIN IMMEDIATE')
        for key, raw in connection.execute('SELECT key, value FROM settings').fetchall():
            try:
                old = json.loads(raw)
            except json.JSONDecodeError:
                old = raw
                new = rebase(old)
                encoded = new
            else:
                new = rebase(old)
                encoded = json.dumps(new, ensure_ascii=False)
            if old != new:
                connection.execute('UPDATE settings SET value=? WHERE key=?', (encoded, key))
        for table in ('workspaces', 'workspace_folders', 'documents', 'knowledge_sources', 'artifacts'):
            for rowid, old in connection.execute(f'SELECT rowid, path FROM {table}').fetchall():
                new = rebase(old)
                if new != old:
                    connection.execute(f'UPDATE {table} SET path=? WHERE rowid=?', (new, rowid))
        assert connection.execute('PRAGMA integrity_check').fetchone()[0] == 'ok'
    connection.close()
    print('Live paths rebased to C:/zeroD; historical records unchanged. Backup:', backup)


if __name__ == '__main__':
    main()
