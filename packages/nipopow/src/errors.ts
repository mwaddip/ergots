export class ProofParseError extends Error {
  constructor(message: string, public readonly code: string, options?: ErrorOptions) {
    super(message, options);
    this.name = 'ProofParseError';
  }
}

export class ProofVerificationError extends Error {
  constructor(message: string, public readonly code: string, options?: ErrorOptions) {
    super(message, options);
    this.name = 'ProofVerificationError';
  }
}

export class EnvelopeParseError extends Error {
  constructor(message: string, public readonly code: string, options?: ErrorOptions) {
    super(message, options);
    this.name = 'EnvelopeParseError';
  }
}
