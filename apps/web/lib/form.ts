/** A text field's value from a submitted form; empty when missing or not text. */
export function formText(form: FormData, name: string): string {
  const value = form.get(name);
  return typeof value === 'string' ? value : '';
}
