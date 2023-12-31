import { Stack } from "./Stack";
import { App } from "@serverless-stack/resources";

export default function (app: App) {
  app.setDefaultFunctionProps({
    runtime: "nodejs16.x",
    srcPath: "services",
    bundle: {
      format: "esm",
    },
  });
  app.stack(Stack, { stackName: `hsbb-courier-helper-v2-${app.stage}`});
}
