import { pino, type Logger } from "pino";
import type { AppConfig } from "./config/env.js";
import { mkdirSync } from "node:fs";
import { dirname } from "node:path";

interface TransportTarget {
  target: string;
  level?: string;
  options?: Record<string, unknown>;
}

export function createLogger(config: Pick<AppConfig, "logLevel" | "logFormat" | "logFile">): Logger {
  const targets: TransportTarget[] = [];

  // stdout target
  if (config.logFormat === "pretty") {
    targets.push({
      target: "pino-pretty",
      level: config.logLevel,
      options: { colorize: true, translateTime: "SYS:HH:MM:ss.l", ignore: "pid,hostname" },
    });
  } else {
    targets.push({
      target: "pino/file",
      level: config.logLevel,
      options: { destination: 1 }, // stdout
    });
  }

  // file target (always JSON for machine-readable logs)
  if (config.logFile) {
    try {
      mkdirSync(dirname(config.logFile), { recursive: true });
    } catch { /* ignore if dir exists */ }
    targets.push({
      target: "pino/file",
      level: config.logLevel,
      options: { destination: config.logFile, mkdir: true },
    });
  }

  return pino({
    level: config.logLevel,
    transport: { targets },
  });
}

export type { Logger };
