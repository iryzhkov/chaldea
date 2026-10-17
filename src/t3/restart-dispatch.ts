import * as Effect from "effect/Effect";
import { withClient, type ConnectOptions } from "./adapter.ts";

/** Only durable refusal/provider-disabled is terminal; transport ambiguity retries identical bytes. */
export async function dispatchRestart(options: ConnectOptions, payload: string): Promise<"accepted" | "refused"> {
  return withClient(options, client => client["orchestration.dispatchCommand"](JSON.parse(payload)).pipe(
    Effect.map(() => "accepted" as const),
    Effect.catchTag("OrchestrationV2DispatchCommandError", error => {
      const detail = error.message + " " + (error.detail ?? "");
      return /previously rejected|disabled|not enabled/i.test(detail)
        ? Effect.succeed("refused" as const) : Effect.fail(error);
    }),
  ));
}
