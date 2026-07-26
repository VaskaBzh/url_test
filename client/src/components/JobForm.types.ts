/** Props controlling submission and validation feedback in the URL form. */
export interface JobFormProps {
  isSubmitting: boolean;
  errorMessage: string | null;
}

/** Events emitted by the URL submission form. */
export interface JobFormEmits {
  submit: [urlsText: string];
}