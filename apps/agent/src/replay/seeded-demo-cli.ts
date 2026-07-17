import { createSeededDemoBundle, runSeededDemo } from './seeded-demo.js';

const bundle = createSeededDemoBundle();
const execution = await runSeededDemo();
process.stdout.write(
  `${JSON.stringify(
    {
      dataMode: bundle.manifest.source.dataMode,
      manifest: bundle.manifest,
      result: execution.result,
      trace: execution.trace,
    },
    null,
    2,
  )}\n`,
);
