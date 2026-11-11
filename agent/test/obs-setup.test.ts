import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { addSlideTransition, hasSlideTransition, sceneCollectionPath } from '../src/obs-setup.js';

describe('V9: adding the Slide transition to the OBS scene collection', () => {
  it('finds the scene collection OBS opens and adds Slide once, keeping a backup', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'obs-'));
    fs.mkdirSync(path.join(dir, 'basic', 'scenes'), { recursive: true });
    fs.writeFileSync(path.join(dir, 'user.ini'), '[General]\nName=x\n\n[Basic]\nProfile=Untitled\nSceneCollectionFile=Golf_Show\n\n[Video]\nBaseCX=1920\n');
    const file = path.join(dir, 'basic', 'scenes', 'Golf_Show.json');
    assert.equal(sceneCollectionPath(dir), null, 'no file yet');
    fs.writeFileSync(file, JSON.stringify({ name: 'Golf Show', sources: [{ name: 'Scene' }], transitions: [{ name: 'Stinger 1', id: 'obs_stinger_transition' }] }));
    assert.equal(sceneCollectionPath(dir), file);
    assert.equal(hasSlideTransition(file), false);
    assert.equal(addSlideTransition(file), true);
    assert.equal(hasSlideTransition(file), true);
    const j = JSON.parse(fs.readFileSync(file, 'utf8'));
    assert.deepEqual(j.transitions.map((t: any) => t.name), ['Stinger 1', 'Slide'], 'keeps the operator\'s own transitions');
    assert.deepEqual(j.sources, [{ name: 'Scene' }]);
    assert.ok(fs.existsSync(file + '.golive.bak'));
    assert.equal(addSlideTransition(file), false, 'only once');
  });

  it('falls back to global.ini, then Untitled', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'obs-'));
    fs.mkdirSync(path.join(dir, 'basic', 'scenes'), { recursive: true });
    fs.writeFileSync(path.join(dir, 'basic', 'scenes', 'Untitled.json'), '{}');
    assert.equal(sceneCollectionPath(dir), path.join(dir, 'basic', 'scenes', 'Untitled.json'));
    fs.writeFileSync(path.join(dir, 'global.ini'), '[Basic]\nSceneCollectionFile=Other\n');
    fs.writeFileSync(path.join(dir, 'basic', 'scenes', 'Other.json'), '{}');
    assert.equal(sceneCollectionPath(dir), path.join(dir, 'basic', 'scenes', 'Other.json'));
  });
});
