export class AppError extends Error {
  constructor(public status: number, public code: string) { super(code); }
}