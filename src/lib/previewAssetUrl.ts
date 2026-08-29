export function previewAssetUrl(source: string, parameter: string, revision: string) {
  const url = new URL(source);
  url.searchParams.set(parameter, revision);
  return url.toString();
}
