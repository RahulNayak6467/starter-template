import * as z from 'zod';

interface IntegerEnvOptions {
  readonly min: number;
  readonly max: number;
  readonly fallback: number;
  readonly unit?: string;
}

const format = (value: number): string => value.toLocaleString('en-US');

// Plain digits only: Number() also accepts hex, exponents and whitespace.
export const integerEnv = (field: string, { min, max, fallback, unit }: IntegerEnvOptions) => {
  const wholeNumber = unit
    ? `${field} must be a whole number of ${unit}`
    : `${field} must be a whole number`;
  const suffix = unit ? ` ${unit}` : '';

  return z
    .string({ error: wholeNumber })
    .regex(/^\d+$/u, { error: wholeNumber })
    .default(String(fallback))
    .transform(Number)
    .pipe(
      z
        .number()
        .min(min, { error: `${field} must be at least ${format(min)}${suffix}` })
        .max(max, { error: `${field} must not exceed ${format(max)}${suffix}` }),
    );
};

type UrlCheck = (url: URL) => readonly string[];

export const connectionUrl = (
  field: string,
  protocols: readonly string[],
  checkUrl: UrlCheck = () => [],
) =>
  z
    .string({ error: `${field} is required` })
    // abort stops the URL checks from adding more issues to an empty value.
    .min(1, { error: `${field} is required`, abort: true })
    .superRefine((value, context) => {
      let url: URL;

      try {
        url = new URL(value);
      } catch {
        context.addIssue({ code: 'custom', message: `${field} must be a valid connection URL` });
        return;
      }

      if (!protocols.includes(url.protocol)) {
        context.addIssue({
          code: 'custom',
          message: `${field} must use the ${protocols.map((protocol) => `${protocol}//`).join(' or ')} protocol`,
        });
        return;
      }

      const problems =
        url.hostname.length === 0 ? [`${field} must include a hostname`] : checkUrl(url);

      for (const message of problems) {
        context.addIssue({ code: 'custom', message });
      }
    });
