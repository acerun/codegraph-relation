import * as assert from 'assert';
import { CodeGraphService } from '../shared/services/CodeGraphService.js';
import { GlobalStatusBar } from '../shared/ui/GlobalStatusBar.js';

suite('GlobalStatusBar Test Suite', () => {
    test('status menu exposes only CodeGraph init and sync actions', () => {
        const items = GlobalStatusBar.createStatusMenuItems();

        assert.deepStrictEqual(items.map(item => item.label), [
            '$(terminal) codegraph init',
            '$(sync) codegraph sync'
        ]);
    });

    test('parses percentage progress from CodeGraph CLI output', () => {
        assert.strictEqual(CodeGraphService.parseProgressPercent('Indexing files 7%'), 7);
        assert.strictEqual(CodeGraphService.parseProgressPercent('Indexed 45 / 100 (45%)'), 45);
        assert.strictEqual(CodeGraphService.parseProgressPercent('Done 100%'), 100);
        assert.strictEqual(CodeGraphService.parseProgressPercent('No progress yet'), undefined);
    });
});
