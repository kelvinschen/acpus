/** Deterministic source-selection and claim-ranking Tasks. */
import { task, z } from "acpus/core";
import {
  LedgerSource,
  RankClaimsInput,
  RankedClaim,
  SelectSourcesInput,
  SelectedSource,
} from "../contracts.js";

type SelectSourcesInput = z.infer<typeof SelectSourcesInput>;
type SelectSourcesResult = {
  sources: Array<z.infer<typeof SelectedSource>>;
  candidateCount: number;
  uniqueCount: number;
  rejectedUrlCount: number;
  duplicateCount: number;
  budgetDropped: number;
};

/** Selects a bounded, relevance-ranked set of canonical public URLs from raw search results. */
export const selectSources = task.define({
  inputSchema: SelectSourcesInput,
  exec: async ({ input }): Promise<SelectSourcesResult> => {
    const value: SelectSourcesInput = input;
    const rank = { high: 0, medium: 1, low: 2 } as const;
    const candidates = value.searches.flatMap(search =>
      search.results.slice(0, 6).map(result => ({
        ...result,
        round: search.round,
        angle: search.angle,
      })),
    ).sort((left, right) => rank[left.relevance] - rank[right.relevance]);

    const blockedHost = (hostname: string) => {
      const host = hostname.replace(/^\[|\]$/g, "").toLowerCase();
      if (host === "localhost" || /\.(?:local|localhost|internal)$/.test(host)) return true;

      const octets = host.split(".").map(Number);
      if (octets.length === 4 && octets.every(part => Number.isInteger(part) && part >= 0 && part <= 255)) {
        const [first = 0, second = 0, third = 0] = octets;
        return first === 0 || first === 10 || first === 127 || first >= 224
          || (first === 100 && second >= 64 && second <= 127)
          || (first === 169 && second === 254)
          || (first === 172 && second >= 16 && second <= 31)
          || (first === 192 && ((second === 0 && (third === 0 || third === 2)) || second === 168))
          || (first === 198 && (second === 18 || second === 19 || (second === 51 && third === 100)))
          || (first === 203 && second === 0 && third === 113);
      }

      if (!host.includes(":")) return false;
      return host === "::" || host === "::1" || /^f[cd]/.test(host) || /^ff/.test(host)
        || /^fe[89ab]/.test(host) || host.startsWith("2001:db8:") || host.startsWith("::ffff:");
    };
    const trackers = new Set(["fbclid", "gclid", "dclid", "msclkid", "mc_cid", "mc_eid"]);
    const normalized = candidates.flatMap(source => {
      try {
        const url = new URL(source.url);
        if ((url.protocol !== "https:" && url.protocol !== "http:") || url.username || url.password || blockedHost(url.hostname)) return [];
        url.hash = "";
        for (const key of [...url.searchParams.keys()]) {
          if (key.toLowerCase().startsWith("utm_") || trackers.has(key.toLowerCase())) url.searchParams.delete(key);
        }
        url.searchParams.sort();
        if (url.pathname !== "/") url.pathname = url.pathname.replace(/\/+$/, "");
        const key = `${url.hostname.replace(/^www\./, "").toLowerCase()}${url.port ? `:${url.port}` : ""}${url.pathname}${url.search}`;
        return [{ ...source, url: url.toString(), key }];
      } catch {
        return [];
      }
    });

    const seen = new Set<string>();
    let duplicateCount = 0;
    const unique = normalized.filter(source => {
      if (seen.has(source.key)) {
        duplicateCount += 1;
        return false;
      }
      seen.add(source.key);
      return true;
    }).map(({ key: _key, ...source }) => source);
    const sources = unique.slice(0, value.sourceLimit);

    return {
      sources,
      candidateCount: candidates.length,
      uniqueCount: unique.length,
      rejectedUrlCount: candidates.length - normalized.length,
      duplicateCount,
      budgetDropped: Math.max(0, unique.length - sources.length),
    };
  },
});

type RankClaimsInput = z.infer<typeof RankClaimsInput>;
type RankClaimsResult = {
  rankedClaims: Array<z.infer<typeof RankedClaim>>;
  claimsExtracted: number;
  duplicateClaims: number;
  claimsDropped: number;
  sources: Array<z.infer<typeof LedgerSource>>;
};

/** Ranks usable extracted claims, removes semantic duplicates, and assigns stable claim IDs. */
export const rankClaims = task.define({
  inputSchema: RankClaimsInput,
  exec: async ({ input }): Promise<RankClaimsResult> => {
    const value: RankClaimsInput = input;
    const importanceRank = { central: 0, supporting: 1, tangential: 2 } as const;
    const qualityRank = { primary: 0, secondary: 1, blog: 2, forum: 3, unreliable: 4 } as const;
    const extracted = value.sources.filter(source => source.sourceQuality !== "unreliable").flatMap(source =>
      source.claims.slice(0, 5)
        .filter(claim => claim.claim.trim() && claim.quote.trim())
        .map(claim => ({
          ...claim,
          sourceUrl: source.url,
          sourceTitle: source.title,
          sourceQuality: source.sourceQuality,
          author: source.author,
          publishDate: source.publishDate,
          angle: source.angle,
        })),
    ).sort((left, right) =>
      importanceRank[left.importance] - importanceRank[right.importance]
      || qualityRank[left.sourceQuality] - qualityRank[right.sourceQuality],
    );
    const seen = new Set<string>();
    const unique = extracted.filter(claim => {
      const key = claim.claim.toLowerCase().replace(/\s+/g, " ").trim();
      if (seen.has(key)) return false;
      seen.add(key);
      return true;
    });
    const rankedClaims = unique.slice(0, value.claimLimit).map((claim, index) => ({
      ...claim,
      claimId: `C${String(index + 1).padStart(3, "0")}`,
    }));

    return {
      rankedClaims,
      claimsExtracted: extracted.length,
      duplicateClaims: extracted.length - unique.length,
      claimsDropped: Math.max(0, unique.length - rankedClaims.length),
      sources: value.sources.map(source => ({
        url: source.url,
        title: source.title,
        round: source.round,
        angle: source.angle,
        relevance: source.relevance,
        quality: source.sourceQuality,
        author: source.author,
        publishDate: source.publishDate,
        summary: source.summary,
        claimCount: source.claims.slice(0, 5).length,
      })),
    };
  },
});
