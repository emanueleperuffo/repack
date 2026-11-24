import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { type Compiler, ModuleFilenameHelpers } from '@rspack/core';
import execa from 'execa';
import { HermesBytecodePlugin } from '../HermesBytecodePlugin/index.js';
import { composeSourceMaps } from '../HermesBytecodePlugin/utils/composeSourceMaps.js';
import { getHermesCLIPath } from '../HermesBytecodePlugin/utils/getHermesCLIPath.js';

jest.mock('node:fs', () => ({
  __esModule: true,
  default: {
    existsSync: jest.fn(),
    promises: {
      access: jest.fn(),
      rename: jest.fn(),
      unlink: jest.fn(),
    },
  },
}));

jest.mock('execa');

jest.mock('../HermesBytecodePlugin/utils/composeSourceMaps');

// Run jobs in the test process: worker processes are covered by HermesWorkerPool.test.ts.
jest.mock('../HermesBytecodePlugin/utils/HermesWorkerPool', () => {
  const { runHermesJob } = jest.requireActual(
    '../HermesBytecodePlugin/utils/runHermesJob'
  );
  return {
    HermesWorkerPool: class {
      run = runHermesJob;
      close() {}
    },
  };
});

function emitAssets(files: string[]) {
  const [, onAssetEmitted] = compilerMock.hooks.assetEmitted.tap.mock.calls[0];
  for (const file of files) {
    onAssetEmitted(file, { outputPath: 'output/path/' });
  }
}

const compilerMock = {
  context: __dirname,
  options: {
    output: {
      compareBeforeEmit: true,
    },
  },
  hooks: {
    assetEmitted: {
      tap: jest.fn(),
    },
    afterEmit: {
      tapPromise: jest.fn(),
    },
  },
  getInfrastructureLogger: () => ({
    debug: jest.fn(),
    info: jest.fn(),
  }),
  webpack: {
    ModuleFilenameHelpers: ModuleFilenameHelpers,
  },
};

describe('HermesBytecodePlugin', () => {
  beforeEach(() => {
    jest.resetAllMocks();
  });

  it('skips compilation if plugin is not enabled', () => {
    const config = {
      enabled: false,
      test: /\.(js)?bundle$/,
      exclude: /index.bundle$/,
    };
    const pluginInstance = new HermesBytecodePlugin(config);

    pluginInstance.apply(compilerMock as unknown as Compiler);

    expect(compilerMock.hooks.afterEmit.tapPromise).not.toHaveBeenCalled();
  });

  it.each([0, -1, 1.5, Number.NaN])(
    'rejects maxWorkers of %p',
    (maxWorkers) => {
      expect(
        () =>
          new HermesBytecodePlugin({
            enabled: true,
            test: /\.bundle$/,
            maxWorkers,
          })
      ).toThrow('maxWorkers must be a positive integer');
    }
  );

  it('overrides compareBeforeEmit webpack option by default', () => {
    const config = {
      enabled: true,
      test: /\.(js)?bundle$/,
      exclude: /index.bundle$/,
    };
    const pluginInstance = new HermesBytecodePlugin(config);

    pluginInstance.apply(compilerMock as unknown as Compiler);

    expect(compilerMock.options.output.compareBeforeEmit).toBe(false);
  });

  describe('transforms bundle to hermes bytecode when plugin is enabled', () => {
    it('with source-maps when found', async () => {
      const config = {
        enabled: true,
        test: /\.(js)?bundle$/,
        exclude: /index.bundle$/,
        reactNativePath: 'path/to/react-native',
        hermesCLIPath: 'path/to/hermesc',
      };
      const pluginInstance = new HermesBytecodePlugin(config);

      const fsMock = fs.promises as jest.Mocked<typeof fs.promises>;
      fsMock.access.mockResolvedValueOnce();

      await new Promise<void>((resolve, reject) => {
        compilerMock.hooks.afterEmit.tapPromise.mockImplementationOnce(
          (_, callback) => {
            emitAssets(['example.bundle']);
            callback().then(resolve).catch(reject);
          }
        );
        pluginInstance.apply(compilerMock as unknown as Compiler);
      });
      const execaMock = execa as jest.MockedFunction<typeof execa>;
      const bundlePath = path.join('output/path/', 'example.bundle');

      expect(compilerMock.hooks.afterEmit.tapPromise).toHaveBeenCalledTimes(1);
      expect(execaMock).toHaveBeenCalledTimes(1);
      expect(execaMock.mock.calls[0][0]).toEqual('path/to/hermesc');

      expect(composeSourceMaps).toHaveBeenCalledTimes(1);
      expect(composeSourceMaps).toHaveBeenCalledWith({
        reactNativePath: 'path/to/react-native',
        packagerMapPath: `${bundlePath}.map`,
        compilerMapPath: `${bundlePath}.hbc.map`,
      });
    });

    it('without source-maps if not found', async () => {
      const config = {
        enabled: true,
        test: /\.(js)?bundle$/,
        exclude: /index.bundle$/,
        reactNativePath: 'path/to/react-native',
        hermesCLIPath: 'path/to/hermesc',
      };
      const pluginInstance = new HermesBytecodePlugin(config);

      const fsMock = fs.promises as jest.Mocked<typeof fs.promises>;
      fsMock.access.mockRejectedValueOnce(new Error('File not found'));

      await new Promise<void>((resolve, reject) => {
        compilerMock.hooks.afterEmit.tapPromise.mockImplementationOnce(
          (_, callback) => {
            emitAssets(['example.bundle']);
            callback().then(resolve).catch(reject);
          }
        );
        pluginInstance.apply(compilerMock as unknown as Compiler);
      });

      const execaMock = execa as jest.MockedFunction<typeof execa>;

      expect(compilerMock.hooks.afterEmit.tapPromise).toHaveBeenCalledTimes(1);
      expect(execaMock).toHaveBeenCalledTimes(1);
      expect(execaMock.mock.calls[0][0]).toEqual('path/to/hermesc');
      expect(composeSourceMaps).not.toHaveBeenCalled();
    });
  });

  it('transforms every matching asset and skips excluded ones', async () => {
    const pluginInstance = new HermesBytecodePlugin({
      enabled: true,
      test: /\.(js)?bundle$/,
      exclude: /index.bundle$/,
      reactNativePath: 'path/to/react-native',
      hermesCLIPath: 'path/to/hermesc',
    });

    const fsMock = fs.promises as jest.Mocked<typeof fs.promises>;
    fsMock.access.mockResolvedValue();

    await new Promise<void>((resolve, reject) => {
      compilerMock.hooks.afterEmit.tapPromise.mockImplementationOnce(
        (_, callback) => {
          emitAssets(['a.chunk.bundle', 'b.chunk.bundle', 'index.bundle']);
          callback().then(resolve).catch(reject);
        }
      );
      pluginInstance.apply(compilerMock as unknown as Compiler);
    });

    const execaMock = execa as jest.MockedFunction<typeof execa>;

    expect(execaMock).toHaveBeenCalledTimes(2);
    expect(composeSourceMaps).toHaveBeenCalledTimes(2);
  });

  it('ignores unchanged assets on rebuild', async () => {
    const pluginInstance = new HermesBytecodePlugin({
      enabled: true,
      test: /\.(js)?bundle$/,
      exclude: /index.bundle$/,
      reactNativePath: 'path/to/react-native',
      hermesCLIPath: 'path/to/hermesc',
    });

    const fsMock = fs.promises as jest.Mocked<typeof fs.promises>;
    fsMock.access.mockResolvedValue();

    pluginInstance.apply(compilerMock as unknown as Compiler);
    const [, afterEmit] = compilerMock.hooks.afterEmit.tapPromise.mock.calls[0];

    emitAssets(['a.chunk.bundle', 'b.chunk.bundle']);
    await afterEmit();

    emitAssets(['b.chunk.bundle']);
    await afterEmit();

    const execaMock = execa as jest.MockedFunction<typeof execa>;
    const transformedBundles = execaMock.mock.calls.map(([, args]) =>
      (args as string[]).at(-1)
    );

    expect(transformedBundles).toEqual([
      path.join('output/path/', 'a.chunk.bundle'),
      path.join('output/path/', 'b.chunk.bundle'),
      path.join('output/path/', 'b.chunk.bundle'),
    ]);
  });

  describe('getHermesCLIPath', () => {
    const reactNativePath = 'path/to/react-native';

    it('returns new hermes-compiler path when it exists', () => {
      jest.spyOn(os, 'platform').mockReturnValue('darwin');
      jest.mocked(fs.existsSync).mockReturnValue(true);

      const hermesPath = getHermesCLIPath(reactNativePath);

      expect(hermesPath).toBe(
        path.normalize('path/to/hermes-compiler/hermesc/osx-bin/hermesc')
      );
    });

    it('falls back to legacy hermesc path when hermes-compiler does not exist', () => {
      jest.spyOn(os, 'platform').mockReturnValue('darwin');
      jest.mocked(fs.existsSync).mockReturnValue(false);

      const hermesPath = getHermesCLIPath(reactNativePath);

      expect(hermesPath).toBe(
        path.normalize('path/to/react-native/sdks/hermesc/osx-bin/hermesc')
      );
    });
  });
});
