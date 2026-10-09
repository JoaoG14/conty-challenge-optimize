import type { DatabaseSync } from "node:sqlite";
import { deliveriesSince } from "./clock.ts";
import { all, get } from "./db.ts";

export type CreatorMatch = {
  id: string;
  name: string;
  niche_score: number;
  latest_reach: number;
  deliveries_90d: number;
};

export type CreatorPage = {
  campaign_id: string;
  total: number;
  creators: CreatorMatch[];
};

type CampaignRow = { niches_json: string };
type CreatorRow = { id: string; name: string; niches_json: string };
type ReachRow = { creator_id: string; latest_reach: number };
type DeliveryRow = { creator_id: string; deliveries_90d: number };

function compareCreators(left: CreatorMatch, right: CreatorMatch): number {
  if (right.niche_score !== left.niche_score) return right.niche_score - left.niche_score;
  if (right.latest_reach !== left.latest_reach) return right.latest_reach - left.latest_reach;
  if (left.id < right.id) return -1;
  if (left.id > right.id) return 1;
  return 0;
}

export async function listCreators(
  db: DatabaseSync,
  input: { campaignId: string; limit: number; offset: number },
): Promise<CreatorPage | null> {
  const campaign = await get<CampaignRow>(db, "SELECT niches_json FROM campaigns WHERE id = ?", input.campaignId);
  if (!campaign) return null;

  const campaignNiches = JSON.parse(campaign.niches_json) as string[];
  const creators = await all<CreatorRow>(db, "SELECT id, name, niches_json FROM creators");
  const reach = await all<ReachRow>(db, `
    WITH ranked_metrics AS (
      SELECT account_id, views,
        ROW_NUMBER() OVER (
          PARTITION BY account_id ORDER BY captured_at DESC, id DESC
        ) AS position
      FROM metrics
    )
    SELECT accounts.creator_id, SUM(metrics.views) AS latest_reach
    FROM social_accounts AS accounts
    JOIN ranked_metrics AS metrics ON metrics.account_id = accounts.id
    WHERE metrics.position = 1
    GROUP BY accounts.creator_id
  `);
  const reachByCreator = new Map(reach.map((row) => [row.creator_id, row.latest_reach]));
  const scored: CreatorMatch[] = [];

  for (const creator of creators) {
    const creatorNiches = JSON.parse(creator.niches_json) as string[];
    let nicheScore = 0;
    for (const campaignNiche of campaignNiches) {
      for (const creatorNiche of creatorNiches) {
        if (campaignNiche === creatorNiche) nicheScore += 1;
      }
    }
    if (nicheScore === 0) continue;

    scored.push({
      id: creator.id,
      name: creator.name,
      niche_score: nicheScore,
      latest_reach: reachByCreator.get(creator.id) ?? 0,
      deliveries_90d: 0,
    });
  }

  scored.sort(compareCreators);
  const page = scored.slice(input.offset, input.offset + input.limit);

  if (page.length > 0) {
    const deliveries = await all<DeliveryRow>(
      db,
      `SELECT creator_id, COUNT(*) AS deliveries_90d
       FROM deliveries
       WHERE delivered_at >= ? AND creator_id IN (SELECT value FROM json_each(?))
       GROUP BY creator_id`,
      deliveriesSince(),
      JSON.stringify(page.map((creator) => creator.id)),
    );
    const deliveriesByCreator = new Map(deliveries.map((row) => [row.creator_id, row.deliveries_90d]));
    for (const creator of page) {
      creator.deliveries_90d = deliveriesByCreator.get(creator.id) ?? 0;
    }
  }

  return {
    campaign_id: input.campaignId,
    total: scored.length,
    creators: page,
  };
}
