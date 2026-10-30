import type { Config } from './config.js';
import type { Repo } from './repo.js';

/** What running the platform costs, for the margin view (Admin > System). All in ₹. */
export interface CostModel {
  fixedMonthlyInr: number;        // servers that run all month (EC2, database, storage)
  cloudEngineInrPerHour: number;  // one cloud OBS engine while it runs
  cameraInrPerHour: number;       // bandwidth per camera-hour (in and out)
  smsInr: number;                 // one SMS through MSG91
  usdInr: number;                 // for costs billed in dollars
}

export interface PlatformValues {
  signupEnabled: boolean;
  costs: CostModel;
}

/**
 * Platform switches an admin changes in the web panel without a redeploy. Values saved there
 * win over the server config; the rest come from the config. Cached in memory.
 */
export class PlatformSettings {
  private cached: PlatformValues;

  constructor(private readonly config: Config, private readonly repo: Repo) {
    this.cached = this.defaults();
  }

  defaults(): PlatformValues {
    const usd = 88;
    return {
      signupEnabled: this.config.SIGNUP_ENABLED,
      costs: { fixedMonthlyInr: 15000, cloudEngineInrPerHour: Math.round(this.config.CLOUD_ENGINE_COST_PER_HOUR * usd * 100) / 100, cameraInrPerHour: 2, smsInr: 0.25, usdInr: usd },
    };
  }

  async reload(): Promise<void> {
    const r = (await this.repo.db.query<{ platform: Partial<PlatformValues> }>('SELECT platform FROM platform_settings WHERE id')).rows[0];
    const d = this.defaults();
    const saved = r?.platform ?? {};
    this.cached = { signupEnabled: saved.signupEnabled ?? d.signupEnabled, costs: { ...d.costs, ...(saved.costs ?? {}) } };
  }

  get values(): PlatformValues {
    return this.cached;
  }

  get signupEnabled(): boolean {
    return this.cached.signupEnabled;
  }

  async save(v: { signupEnabled?: boolean; costs?: Partial<CostModel> }): Promise<PlatformValues> {
    const r = (await this.repo.db.query<{ platform: Partial<PlatformValues> }>('SELECT platform FROM platform_settings WHERE id')).rows[0];
    const next = { ...(r?.platform ?? {}), ...v, ...(v.costs ? { costs: { ...(r?.platform?.costs ?? {}), ...v.costs } } : {}) };
    await this.repo.db.query('UPDATE platform_settings SET platform = $1 WHERE id', [JSON.stringify(next)]);
    await this.reload();
    return this.cached;
  }
}
