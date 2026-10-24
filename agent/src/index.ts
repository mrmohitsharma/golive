#!/usr/bin/env node
import { OBSWebSocket, EventSubscription } from 'obs-websocket-js';
import { loadConfig, loadDotEnv } from './config.js';
import { Agent, type ObsConnector } from './agent.js';

loadDotEnv();
const config = loadConfig();

const obs = new OBSWebSocket();
const connector: ObsConnector = {
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

const agent = new Agent(config, connector);
console.log(`CoGolfer OBS agent: tournament ${config.tournamentId}, server ${config.serverUrl}, OBS ${config.obsUrl}`);
void agent.start();

const shutdown = async () => {
  await agent.stop();
  process.exit(0);
};
process.on('SIGINT', () => void shutdown());
process.on('SIGTERM', () => void shutdown());
