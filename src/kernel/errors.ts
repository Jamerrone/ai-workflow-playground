export class EngineDisposedError extends Error {
  constructor(message = "Engine has been disposed") {
    super(message);
    this.name = "EngineDisposedError";
  }
}
