import type { Config } from './config.js';
import type { Repo } from './repo.js';
import type { ScoringRepo } from './scoring.js';
import type { Hub } from './hub.js';
import type { YouTubeService } from './youtube.js';
import type { MediaService } from './replay.js';
import type { GraphicsService } from './graphics.js';
import type { CloudEngineManager } from './cloud.js';
import type { Sealer } from './crypto.js';
import type { HealthPoller } from './health.js';
import type { Thumbnailer } from './thumbnails.js';
import type { FacebookService } from './facebook.js';
import type { OutputsService } from './outputs.js';
import type { RelayManager } from './relay.js';
import type { BillingService } from './billing.js';
import type { PaymentsService } from './payments.js';
import type { ChatService } from './chat.js';
import type { ChatReaders } from './chat-readers.js';
import type { DestinationsService } from './destinations.js';

/** Everything route modules need. */
export interface Ctx {
  config: Config;
  repo: Repo;
  scoring: ScoringRepo;
  hub: Hub;
  youtube: YouTubeService;
  facebook: FacebookService;
  outputs: OutputsService;
  relay: RelayManager;
  media: MediaService;
  graphics: GraphicsService;
  cloud: CloudEngineManager;
  sealer: Sealer;
  poller: HealthPoller;
  thumbs: Thumbnailer;
  billing: BillingService;
  payments: PaymentsService;
  chat: ChatService;
  chatReaders: ChatReaders;
  destinations: DestinationsService;
}
