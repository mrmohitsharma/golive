#!/usr/bin/env node
import { OBSWebSocket, EventSubscription } from 'obs-websocket-js';
import { loadConfig, loadDotEnv, type AgentConfig } from './config.js';
import { Agent, type ObsConnector } from './agent.js';
import { runApp } from './app.js';

function connector(): ObsConnector {
  const obs = new OBSWebSocket();
  return {
    client: obs as unknown as ObsConnector['client'],
    async connect(url, password) {
      await obs.connect(url, password, {
        rpcVersion: 1,
        eventSubscriptions:
          EventSubscription.General |
          EventSubscription.Scenes |
          EventSubscription.Ui |
          EventSubscription.Outputs |
          EventSubscription.MediaInputs |
          EventSubscription.InputVolumeMeters,
      });
    },
    async disconnect() {
      await obs.disconnect();
    },
  };
}

let agent: Agent | null = null;
const shutdown = async () => {
  await agent?.stop();
  process.exit(0);
};
process.on('SIGINT', () => void shutdown());
process.on('SIGTERM', () => void shutdown());

loadDotEnv();
if (process.env.TOURNAMENT_ID && process.env.ENGINE_KEY) {
  // Cloud engine and older laptop setups: settings from .env / the environment.
  const config = loadConfig();
  agent = new Agent(config, connector());
  console.log(`Go Live OBS agent: event ${config.tournamentId}, server ${config.serverUrl}, OBS ${config.obsUrl}`);
  void agent.start();
} else {
  // The Go Live agent app: pairing code, OBS set up for you, events picked on the website.
  runApp((cfg: AgentConfig) => {
    agent = new Agent(cfg, connector());
    void agent.start({ server: false });
    return agent;
  }).catch(async (err) => {
    console.error(`\n  Something went wrong: ${(err as Error).message}\n`);
    if (process.stdin.isTTY) {
      console.log('  Press Enter to close.');
      process.stdin.once('data', () => process.exit(1));
    } else process.exit(1);
  });
}
