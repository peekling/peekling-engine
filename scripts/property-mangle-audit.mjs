export function auditPropertyMangles(
  properties,
  input,
  output,
  nameCache,
  candidateNameCache,
) {
  const mappings = nameCache.props?.props ?? {};
  const candidates = candidateNameCache.props?.props ?? {};
  for (const property of properties) {
    const key = `$${property}`;
    if (
      !Object.hasOwn(candidates, key) ||
      !hasUnquotedPropertySyntax(input, property)
    ) {
      continue;
    }
    const mapped = mappings[key];
    if (typeof mapped !== "string" || mapped === property) {
      throw new Error(
        `Configured runtime property ${property} was not mapped by Terser`,
      );
    }
    if (hasPropertySyntax(output, property)) {
      throw new Error(
        `Configured runtime property ${property} remains in the minified artifact`,
      );
    }
  }
}

function hasPropertySyntax(source, property) {
  return (
    hasUnquotedPropertySyntax(source, property) ||
    new RegExp(
      `(?:\\[\\s*["']${property}["']\\s*\\]|(?:^|[,{;}])\\s*["']${property}["']\\s*(?=[:(]))`,
      "m",
    ).test(source)
  );
}

function hasUnquotedPropertySyntax(source, property) {
  return new RegExp(
    `(?:\\.\\s*${property}(?![A-Za-z0-9_$])|(?:^|[,{;}])\\s*${property}\\s*(?=[:(]))`,
    "m",
  ).test(source);
}
