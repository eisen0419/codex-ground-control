export class ManagedWorkflowError extends Error {
  constructor(code, message) {
    super(message);
    this.name = "ManagedWorkflowError";
    this.code = code;
  }
}
