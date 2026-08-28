export const NAME_PATTERN = /^(?!peekling:)[a-z][a-z0-9:-]{0,63}$/;
export const EVENT_NAME_PATTERN =
  /^(?=.{1,64}$)[a-z][a-z0-9]*(?:[.:-][a-z][a-z0-9-]*)*$/;
export const STATE_NAME_PATTERN =
  /^(?=.{1,64}$)[a-z][a-z0-9-]*(?::[A-Za-z0-9.-]+)?$/;
export const SEMVER_PATTERN =
  /^(0|[1-9][0-9]*)\.(0|[1-9][0-9]*)\.(0|[1-9][0-9]*)(?:-[0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*)?(?:\+[0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*)?$/;
export const SPDX_LICENSE_PATTERN =
  /^(?:[A-Za-z0-9][A-Za-z0-9.-]{0,63}|DocumentRef-[A-Za-z0-9][A-Za-z0-9.-]{0,31}:LicenseRef-[A-Za-z0-9][A-Za-z0-9.-]{0,31})$/;
export const ASSET_PATH_PATTERN =
  /^(?!\/)(?!.*(?:^|\/)\.\.?(?:\/|$))(?!.*\/\/)[A-Za-z0-9._/-]{1,256}$/;
export const SURFACE_COLOR_PATTERN =
  /^(?:transparent|#(?:[0-9A-Fa-f]{3,4}|[0-9A-Fa-f]{6}|[0-9A-Fa-f]{8}))(?![\s\S])/;

export function isSurfaceColor(value: unknown): value is string {
  return typeof value === "string" && SURFACE_COLOR_PATTERN.test(value);
}

export function isHttpPath(value: unknown, base: string): value is string {
  if (
    typeof value !== "string" ||
    value.length < 1 ||
    value.length > 2_048 ||
    /[\s\u0000-\u001f\u007f-\u009f\\]/u.test(value) ||
    /%(?![0-9A-Fa-f]{2})/.test(value)
  ) {
    return false;
  }
  const absoluteHttps = /^https:\/\//i.test(value);
  if (
    (!absoluteHttps && /^[A-Za-z][A-Za-z0-9+.-]*:/.test(value)) ||
    value.startsWith("//") ||
    (absoluteHttps && !validHttpsAuthority(value))
  ) {
    return false;
  }
  try {
    if (absoluteHttps) {
      const resolved = new URL(value);
      return (
        resolved.protocol === "https:" &&
        !resolved.username &&
        !resolved.password &&
        hasCanonicalHttpsHostname(value, resolved.hostname)
      );
    }
    const baseUrl = new URL(base);
    if (
      (baseUrl.protocol !== "https:" && baseUrl.protocol !== "http:") ||
      baseUrl.username ||
      baseUrl.password ||
      !validParsedHostname(baseUrl.hostname)
    ) {
      return false;
    }
    const resolved = new URL(value, baseUrl);
    return (
      !resolved.username &&
      !resolved.password &&
      (resolved.protocol === "https:" || resolved.protocol === "http:") &&
      resolved.origin === baseUrl.origin
    );
  } catch {
    return false;
  }
}

function hasCanonicalHttpsHostname(value: string, parsed: string): boolean {
  const remainder = value.slice(8);
  const boundary = remainder.search(/[/?#]/);
  const authority = boundary < 0 ? remainder : remainder.slice(0, boundary);
  if (authority.startsWith("[")) return true;
  const colon = authority.indexOf(":");
  const hostname = colon < 0 ? authority : authority.slice(0, colon);
  return hostname.toLowerCase() === parsed.toLowerCase();
}

function validHttpsAuthority(value: string): boolean {
  const remainder = value.slice(8);
  const boundary = remainder.search(/[/?#]/);
  const authority = boundary < 0 ? remainder : remainder.slice(0, boundary);
  if (!authority || authority.includes("@") || authority.includes("%")) {
    return false;
  }
  if (authority.startsWith("[")) {
    const close = authority.indexOf("]");
    if (
      close < 2 ||
      authority.indexOf("[", 1) >= 0 ||
      authority.indexOf("]", close + 1) >= 0 ||
      !validPortSuffix(authority.slice(close + 1))
    ) {
      return false;
    }
    return true;
  }
  const firstColon = authority.indexOf(":");
  const lastColon = authority.lastIndexOf(":");
  if (firstColon !== lastColon) return false;
  const hostname = firstColon < 0 ? authority : authority.slice(0, firstColon);
  const suffix = firstColon < 0 ? "" : authority.slice(firstColon);
  return validAsciiHostname(hostname) && validPortSuffix(suffix);
}

function validPortSuffix(value: string): boolean {
  if (value === "") return true;
  if (!/^:[0-9]{1,5}$/.test(value)) return false;
  return Number(value.slice(1)) <= 65_535;
}

function validParsedHostname(value: string): boolean {
  return value.startsWith("[")
    ? value.endsWith("]")
    : validAsciiHostname(value);
}

function validAsciiHostname(value: string): boolean {
  if (!value || value.length > 253 || value.endsWith(".")) return false;
  const labels = value.split(".");
  if (labels.every((label) => /^[0-9]+$/.test(label))) {
    return (
      labels.length === 4 &&
      labels.every(
        (label) =>
          /^(?:0|[1-9][0-9]{0,2})$/.test(label) && Number(label) <= 255,
      )
    );
  }
  return labels.every((label) =>
    /^(?:[A-Za-z0-9]|[A-Za-z0-9][A-Za-z0-9-]{0,61}[A-Za-z0-9])$/.test(label),
  );
}
