function exactKeys(value, keys) {
  return (
    value !== null &&
    !Array.isArray(value) &&
    typeof value === "object" &&
    Object.keys(value).length === keys.length &&
    keys.every((key) => Object.hasOwn(value, key))
  );
}

function sourceUrlAllowed(url, rules) {
  return (
    url.protocol === "https:" &&
    url.username === "" &&
    url.password === "" &&
    url.search === "" &&
    url.hash === "" &&
    rules.allowedOrigins.includes(url.origin) &&
    rules.allowedPaths.includes(url.pathname)
  );
}

export function validAgySourceRules(rules) {
  return (
    exactKeys(rules, [
      "allowedOrigins",
      "allowedPaths",
      "allowedIdentities",
      "pathIdentityMap",
      "maxObservationAgeMilliseconds",
      "maxFutureSkewMilliseconds",
      "fetch",
      "contentContains",
      "maxResponseBytes",
      "maxRedirects",
      "fetchTimeoutMilliseconds",
      "privateContextAllowed",
    ]) &&
    Array.isArray(rules.allowedOrigins) &&
    rules.allowedOrigins.length === 1 &&
    rules.allowedOrigins[0] === "https://www.python.org" &&
    Array.isArray(rules.allowedPaths) &&
    rules.allowedPaths.length === 1 &&
    rules.allowedPaths[0] === "/" &&
    Array.isArray(rules.allowedIdentities) &&
    rules.allowedIdentities.length === 1 &&
    rules.allowedIdentities[0] ===
      "Python Software Foundation official website" &&
    exactKeys(rules.pathIdentityMap, ["/"]) &&
    rules.pathIdentityMap["/"] === rules.allowedIdentities[0] &&
    rules.maxObservationAgeMilliseconds === 3_600_000 &&
    rules.maxFutureSkewMilliseconds === 300_000 &&
    rules.fetch === true &&
    Array.isArray(rules.contentContains) &&
    rules.contentContains.length === 1 &&
    rules.contentContains[0] === "Python" &&
    rules.maxResponseBytes === 1_000_000 &&
    rules.maxRedirects === 3 &&
    rules.fetchTimeoutMilliseconds === 15_000 &&
    rules.privateContextAllowed === false
  );
}

export function agySourceObservationMatches(
  source,
  rules,
  options = {},
) {
  const now = options.now ?? Date.now();
  const startedAt = options.startedAt ?? now;
  let url;
  try {
    url = new URL(source?.url);
  } catch {
    url = null;
  }
  const observedAt = Date.parse(source?.observedAt);
  return (
    validAgySourceRules(rules) &&
    exactKeys(source, ["url", "identity", "observedAt"]) &&
    url !== null &&
    source.url === url.href &&
    sourceUrlAllowed(url, rules) &&
    rules.allowedIdentities.includes(source.identity) &&
    rules.pathIdentityMap[url.pathname] === source.identity &&
    Number.isFinite(observedAt) &&
    source.observedAt === new Date(observedAt).toISOString() &&
    observedAt >= startedAt - 300_000 &&
    observedAt <= now + rules.maxFutureSkewMilliseconds &&
    now - observedAt <= rules.maxObservationAgeMilliseconds
  );
}

async function readBoundedResponseBody(response, maxBytes) {
  if (response.body === null) {
    return Buffer.alloc(0);
  }
  const reader = response.body.getReader();
  const chunks = [];
  let total = 0;
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) {
        break;
      }
      total += value.byteLength;
      if (total > maxBytes) {
        await reader.cancel("source response exceeds byte limit");
        throw new Error("AGY source response exceeds its byte limit.");
      }
      chunks.push(Buffer.from(value));
    }
  } finally {
    reader.releaseLock();
  }
  return Buffer.concat(chunks, total);
}

async function fetchAllowlistedSource(
  initialUrl,
  rules,
  fetchImplementation,
) {
  let current = new URL(initialUrl);
  for (
    let redirect = 0;
    redirect <= rules.maxRedirects;
    redirect += 1
  ) {
    if (!sourceUrlAllowed(current, rules)) {
      throw new Error("AGY source redirect is not allowlisted.");
    }
    const response = await fetchImplementation(current, {
      redirect: "manual",
      signal: AbortSignal.timeout(
        rules.fetchTimeoutMilliseconds,
      ),
      headers: {
        "user-agent": "codex-ground-control/0.2",
      },
    });
    if (response.status >= 300 && response.status < 400) {
      const location = response.headers.get("location");
      if (!location) {
        throw new Error("AGY source redirect has no location.");
      }
      await response.body?.cancel();
      current = new URL(location, current);
      continue;
    }
    const body = await readBoundedResponseBody(
      response,
      rules.maxResponseBytes,
    );
    return {
      finalUrl: current.href,
      httpStatus: response.status,
      body: body.toString("utf8"),
    };
  }
  throw new Error("AGY source redirect limit exceeded.");
}

export async function verifyAgySourceObservation(
  source,
  rules,
  options = {},
) {
  const now = options.now ?? Date.now();
  const startedAt = options.startedAt ?? now;
  if (
    rules.fetch !== true ||
    !agySourceObservationMatches(source, rules, {
      now,
      startedAt,
    })
  ) {
    throw new Error("AGY source observation is not allowlisted.");
  }
  const fetched = await fetchAllowlistedSource(
    source.url,
    rules,
    options.fetchImplementation ?? fetch,
  );
  const lowerBody = fetched.body.toLocaleLowerCase("en-US");
  const markersMatched = rules.contentContains.every((marker) =>
    lowerBody.includes(marker.toLocaleLowerCase("en-US"))
  );
  if (
    fetched.httpStatus < 200 ||
    fetched.httpStatus >= 300 ||
    !markersMatched
  ) {
    throw new Error("AGY source identity could not be verified.");
  }
  return {
    checkedAt: new Date(options.now ?? Date.now()).toISOString(),
    finalUrl: fetched.finalUrl,
    httpStatus: fetched.httpStatus,
    contentMarkersMatched: true,
    verified: true,
  };
}
