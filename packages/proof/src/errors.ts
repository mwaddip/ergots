export class ProofParseError extends Error {
  constructor(message: string, public readonly code: string) {
    super(message);
    this.name = 'ProofParseError';
  }
}

export class ProofVerificationError extends Error {
  constructor(message: string, public readonly code: string) {
    super(message);
    this.name = 'ProofVerificationError';
  }
}

export class EnvelopeParseError extends Error {
  constructor(message: string, public readonly code: string) {
    super(message);
    this.name = 'EnvelopeParseError';
  }
}
