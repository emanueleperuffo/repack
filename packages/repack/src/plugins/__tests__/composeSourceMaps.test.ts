import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { composeSourceMaps } from '../HermesBytecodePlugin/utils/composeSourceMaps.js';

const reactNativePath = path.dirname(
  require.resolve('react-native/package.json')
);

// `var a = 1;` in `src/a.js`, bundled to line 1, column 0.
const packagerMap = {
  version: 3,
  sources: ['src/a.js'],
  names: [],
  mappings: 'AAAA',
};

// Hermes output mapped back to the bundle, line 1, column 0.
const compilerMap = {
  version: 3,
  sources: ['bundle.js'],
  names: [],
  mappings: 'AAAA',
};

describe('composeSourceMaps', () => {
  let dir: string;
  let packagerMapPath: string;
  let compilerMapPath: string;

  beforeEach(() => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'repack-compose-test-'));
    packagerMapPath = path.join(dir, 'a.chunk.bundle.map');
    compilerMapPath = path.join(dir, 'a.chunk.bundle.hbc.map');
  });

  afterEach(() => {
    fs.rmSync(dir, { recursive: true, force: true });
  });

  function writeMaps(packager: object, compiler: object) {
    fs.writeFileSync(packagerMapPath, JSON.stringify(packager));
    fs.writeFileSync(compilerMapPath, JSON.stringify(compiler));
  }

  it('replaces the packager source map with the composed one', async () => {
    writeMaps(packagerMap, compilerMap);

    await composeSourceMaps({
      reactNativePath,
      packagerMapPath,
      compilerMapPath,
    });

    const composed = JSON.parse(fs.readFileSync(packagerMapPath, 'utf8'));
    expect(composed.sources).toEqual(['src/a.js']);
    expect(composed.mappings).toBe('AAAA');
    expect(fs.readdirSync(dir)).toEqual(['a.chunk.bundle.map']);
  });

  it('rejects RAM bundle source maps', async () => {
    writeMaps({ ...packagerMap, x_facebook_offsets: [] }, compilerMap);

    await expect(
      composeSourceMaps({ reactNativePath, packagerMapPath, compilerMapPath })
    ).rejects.toThrow('x_facebook_offsets');
  });

  it('rejects compiler source maps with segments', async () => {
    writeMaps(packagerMap, { ...compilerMap, x_facebook_segments: {} });

    await expect(
      composeSourceMaps({ reactNativePath, packagerMapPath, compilerMapPath })
    ).rejects.toThrow('x_facebook_segments');
  });
});
