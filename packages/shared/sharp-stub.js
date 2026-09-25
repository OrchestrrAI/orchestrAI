// specs/020-semantic-intent-fallback/spec.md — @huggingface/transformers's
// entry point eagerly loads "sharp" (an image library) even when only its
// pure-JS tokenizer is used for text. sharp is a native addon that cannot
// be embedded into a `bun build --compile` binary (confirmed via a spike:
// the compiled binary crashed with "Could not load the sharp module"
// without this stub) and isn't needed for anything this repo does with
// the package — intent-classifier.ts never touches image input.
export default {}
export const cache = () => {}
