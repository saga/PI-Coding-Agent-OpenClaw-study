import type { ExtensionAPI, ExtensionContext } from "@mariozechner/pi-coding-agent";

export default function enhancedWorkingStatusExtension(api: ExtensionAPI): void {
  const SPINNER_FRAMES = ["⠋", "⠙", "⠹", "⠸", "⠼", "⠴", "⠦", "⠧", "⠇", "⠏"];
  let currentFrameIndex = 0;
  let intervalId: NodeJS.Timeout | null = null;
  let currentStatus = "";

  const getSpinner = (): string => {
    currentFrameIndex = (currentFrameIndex + 1) % SPINNER_FRAMES.length;
    return SPINNER_FRAMES[currentFrameIndex];
  };

  const clearLine = (): void => {
    process.stdout.write("\r" + "\x1b[K");
  };

  const displayWorking = (status: string): void => {
    clearLine();
    const spinner = getSpinner();
    const timestamp = new Date().toLocaleTimeString();
    process.stdout.write(`\x1b[36m${spinner}\x1b[0m \x1b[33m${status}\x1b[0m [\x1b[90m${timestamp}\x1b[0m]`);
  };

  const displayDone = (status: string, duration: number): void => {
    clearLine();
    const timestamp = new Date().toLocaleTimeString();
    const durationSec = (duration / 1000).toFixed(2);
    process.stdout.write(`\x1b[32m✓\x1b[0m ${status} [\x1b[90m${timestamp}\x1b[0m] \x1b[90m(${durationSec}s)\x1b[0m\n`);
  };

  api.on("agent_start", (event, ctx) => {
    currentStatus = "Agent starting";
    const sessionId = ctx.sessionManager?.sessionId ?? "unknown";
    
    console.log("\n");
    console.log("\x1b[1;34m" + "=".repeat(60) + "\x1b[0m");
    console.log(`\x1b[1;34m\x1b[1m Agent Started \x1b[0m`);
    console.log("\x1b[1;34m" + "=".repeat(60) + "\x1b[0m");
    console.log(`\x1b[90mSession:\x1b[0m ${sessionId}`);
    if (ctx.params?.modelId) {
      console.log(`\x1b[90mModel:\x1b[0m ${ctx.params.modelId}`);
    }
    console.log("");

    intervalId = setInterval(() => {
      displayWorking(currentStatus);
    }, 100);
  });

  api.on("agent_end", (event, ctx) => {
    if (intervalId) {
      clearInterval(intervalId);
      intervalId = null;
    }

    const duration = ctx.sessionManager?.createdAt 
      ? Date.now() - ctx.sessionManager.createdAt.getTime() 
      : 0;
    
    if (event.meta?.error) {
      console.log(`\x1b[31m✗ Agent failed: ${event.meta.error}\x1b[0m`);
    } else {
      displayDone("Agent", duration);
    }
    
    console.log("\x1b[1;34m" + "=".repeat(60) + "\x1b[0m\n");
    
    currentStatus = "";
    currentFrameIndex = 0;
  });

  api.on("tool_call", (event, ctx) => {
    currentStatus = `Executing: ${event.toolName}`;
    console.log(`\x1b[90m→\x1b[0m \x1b[33m${event.toolName}\x1b[0m`);
  });

  api.on("tool_result", (event, ctx) => {
    const isError = event.result?.isError ?? false;
    const icon = isError ? "\x1b[31m✗\x1b[0m" : "\x1b[32m✓\x1b[0m";
    console.log(`  ${icon} \x1b[33m${event.toolName}\x1b[0m ${isError ? "failed" : "done"}`);
  });

  api.on("context", (event, ctx) => {
    const messageCount = event.messages?.length ?? 0;
    const tokenEstimate = Math.round(messageCount * 150);
    currentStatus = `Processing context (${messageCount} messages, ~${tokenEstimate} tokens)`;
    displayWorking(currentStatus);
  });

  api.on("error", (event, ctx) => {
    if (intervalId) {
      clearInterval(intervalId);
      intervalId = null;
    }
    console.log("");
    console.log(`\x1b[1;31m✗ Error: ${event.error?.message ?? "Unknown error"}\x1b[0m`);
    console.log("");
  });

  api.on("thinking_start", (event, ctx) => {
    console.log("");
    console.log(`\x1b[35m🤔\x1b[0m \x1b[35mThinking...\x1b[0m`);
    
    intervalId = setInterval(() => {
      const thoughts = ["Analyzing", "Planning", "Reasoning", "Processing"];
      const thoughtIndex = Math.floor(Date.now() / 2000) % thoughts.length;
      currentStatus = `Thinking: ${thoughts[thoughtIndex]}`;
      displayWorking(currentStatus);
    }, 150);
  });

  api.on("thinking_end", (event, ctx) => {
    if (intervalId) {
      clearInterval(intervalId);
      intervalId = null;
    }
    console.log(`\x1b[32m💡\x1b[0m \x1b[32mThought complete\x1b[0m`);
  });
}
