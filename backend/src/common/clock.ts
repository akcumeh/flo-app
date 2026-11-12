export class Clock {
  now(): Date {
    return new Date();
  }
}

export class FixedClock extends Clock {
  private at: Date;

  constructor(at: Date | string = new Date()) {
    super();
    this.at = new Date(at);
  }

  now(): Date {
    return new Date(this.at);
  }

  set(at: Date | string) {
    this.at = new Date(at);
  }
}

export const CLOCK = Symbol('CLOCK');
