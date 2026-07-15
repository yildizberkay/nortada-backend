// The Emscripten package ships no types — declare the factory shape we use
// (a modularized builder returning a fresh instance per call).
declare module "@openmeteo/file-format-wasm" {
  const factory: () => Promise<Record<string, unknown>>;
  export default factory;
}
