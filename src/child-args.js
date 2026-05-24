const BASE_URL_ARG = /(?:^|[._-])base[._-]?url(?:$|[=._-])|baseurl|BASE_URL/i;

function escapeRegExp(s) {
  return s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function placeholderPatterns(envVar) {
  const escaped = escapeRegExp(envVar);
  return [
    new RegExp(`\\$env:${escaped}`, "g"),
    new RegExp(`\\$\\{env:${escaped}\\}`, "g"),
    new RegExp(`%${escaped}%`, "g"),
    new RegExp(`\\$${escaped}\\b`, "g"),
    new RegExp(`\\$\\{${escaped}\\}`, "g"),
  ];
}

function isBaseUrlContext(args, index, envVar) {
  const arg = String(args[index] ?? "");
  const prev = String(args[index - 1] ?? "");
  return arg.includes(envVar) || BASE_URL_ARG.test(arg) || BASE_URL_ARG.test(prev);
}

export function proxyArgs(args, envVar, proxyUrl, env = process.env, upstream = null) {
  const directValues = [...new Set([env[envVar], upstream].filter((v) => v && v !== proxyUrl))];
  const patterns = placeholderPatterns(envVar);

  return args.map((arg, index) => {
    let next = String(arg);
    for (const pattern of patterns) next = next.replace(pattern, proxyUrl);

    if (isBaseUrlContext(args, index, envVar)) {
      for (const value of directValues) next = next.replaceAll(value, proxyUrl);
    }

    return next;
  });
}