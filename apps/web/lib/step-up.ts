/**
 * Asking for the second factor in the middle of an action (FR-GOV-04, #85). The app's prompt
 * registers itself here once; `api()` calls `stepUp()` when a request, an admin action or any
 * other of someone whose organization asks the code before anything else, answers 403
 * second_factor_required, and repeats the request once the code is in. Its own module, with
 * no imports, so the API helper and the prompt don't import each other.
 */

type StepUp = () => Promise<boolean>;

let ask: StepUp | null = null;

/** The prompt that asks for the code; null when it goes away. */
export function onStepUp(prompt: StepUp | null): void {
  ask = prompt;
}

/** Asks for the code now. True once this session has passed it; false if not asked, or not given. */
export function stepUp(): Promise<boolean> {
  return ask ? ask() : Promise.resolve(false);
}

/** Whether an answer from our API asks for the second factor. */
export const isStepUp = (status: number, code: string | undefined) =>
  status === 403 && code === 'second_factor_required';

/*
 * An email that needs its own authenticator (#88): a person with an authenticator on another
 * of their emails, signed in with one that has none, while their organization has the second
 * factor on. There is no code to enter yet, so it is never asked for one: `api()` tells the
 * screen that says so, which sends them to Settings › Sign-ins to add one.
 */

type Held = (email: string | null) => void;

let held: Held | null = null;

/** The screen that says this email needs its own authenticator; null when it goes away. */
export function onAuthenticatorRequired(screen: Held | null): void {
  held = screen;
}

/** Says this email, or the one signed in when the API didn't name it, needs its own. */
export function authenticatorRequired(email: string | null): void {
  held?.(email);
}

/** Whether an answer from our API holds this email until it adds its own authenticator. */
export const isAuthenticatorRequired = (status: number, code: string | undefined) =>
  status === 403 && code === 'authenticator_required';
