// NodejsFunction handler — TypeScript, bundled by esbuild at synth time.
// A tiny local helper forces a real (multi-symbol) bundle rather than a verbatim
// copy, so the integ exercises esbuild output + cdkd asset publishing.
const greeting = (name: string): string => `hello ${name} from nodejs-function`;

export const handler = async (): Promise<{ statusCode: number; body: string }> => {
  return { statusCode: 200, body: JSON.stringify({ msg: greeting('cdkd') }) };
};
