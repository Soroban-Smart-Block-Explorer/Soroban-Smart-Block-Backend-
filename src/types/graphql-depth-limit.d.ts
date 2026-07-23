declare module 'graphql-depth-limit' {
  import { ValidationRule } from 'graphql';
  function depthLimit(
    maxDepth: number,
    options?: {
      ignore?: string[];
    },
  ): ValidationRule;
  export default depthLimit;
}
