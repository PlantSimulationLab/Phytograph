// Is this dropped/opened path a RIEGL raw project directory?
//
// A .riproject is a DIRECTORY, and react-dropzone expands a dropped folder into
// its contents — so by the time `onDrop` runs it has become ~100 .rxp/.jpg/.ppm
// files that the generic point-cloud importer rejects one by one
// ("Unsupported file format: .ppm"). The capture phase sees the un-expanded
// entry, and this is the test it applies there.
//
// Deliberately anchored to the END of the path: a file INSIDE the project must
// never match, or a single stray .rxp would be mistaken for the whole project.
export function isRieglProjectPath(path: string | undefined | null): boolean {
  if (!path) return false;
  return /\.riproject\/?$/i.test(path);
}
