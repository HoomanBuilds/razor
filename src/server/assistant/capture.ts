import { InferenceClient } from "@nearai/inference-sdk/node";

class CaptureHook extends InferenceClient {
  responseHookType() { return this.registerResponse; }
}
type Capture = Parameters<ReturnType<CaptureHook["responseHookType"]>>[0];

export class EvidenceInferenceClient extends InferenceClient {
  private readonly wire = new Map<string, Promise<{ requestBody: Uint8Array; responseBody: Uint8Array }>>();

  protected override registerResponse(captured: Capture, generation: number): void {
    if (generation !== this.responseCacheGeneration) return;
    super.registerResponse(captured, generation);
    const requestBody = captured.requestBody.slice();
    const bytes = captured.responseBody.then(responseBody => ({ requestBody, responseBody: responseBody.slice() }));
    void bytes.catch(() => {});
    this.wire.set(captured.id, bytes);
  }

  async capturedWire(id: string) {
    const bytes = this.wire.get(id);
    if (!bytes) throw new Error("The SDK did not capture this completion's signed wire bytes");
    return bytes;
  }

  override clearResponseCache(): void {
    super.clearResponseCache();
    this.wire.clear();
  }
}
