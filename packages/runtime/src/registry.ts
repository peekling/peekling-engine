import { runtimeMessage } from "./runtime-diagnostics.js";

declare const __PEEK_PACK_URL__: string;
declare const __PEEK_PACK_SHA256__: string;

const PEEK_REFERENCE_URL =
  typeof __PEEK_PACK_URL__ === "string"
    ? __PEEK_PACK_URL__
    : "https://cdn.jsdelivr.net/npm/@peekling/pack-peek@0.1.1/character.json";
const PEEK_REFERENCE_SHA256 =
  typeof __PEEK_PACK_SHA256__ === "string"
    ? __PEEK_PACK_SHA256__
    : "9a2e2a41e85f7c4b8d3487a3655db40872675bd9c0780e139a946eabdf71d75f";

interface CharacterPackReference {
  readonly url: string;
  readonly sha256: string;
}

const REGISTRY: Readonly<Record<string, CharacterPackReference>> = {
  peek: Object.freeze({
    url: PEEK_REFERENCE_URL,
    sha256: PEEK_REFERENCE_SHA256,
  }),
};

export function isRegisteredCharacter(character: string): boolean {
  return Object.hasOwn(REGISTRY, character);
}

export function characterPackReference(
  character: string,
): CharacterPackReference {
  if (!isRegisteredCharacter(character))
    throw new Error(
      runtimeMessage(
        "character.unknown",
        `Unknown Peekling character: ${character}`,
      ),
    );
  return REGISTRY[character]!;
}

export function characterManifestUrl(character: string): string {
  return characterPackReference(character).url;
}
