/**
 * Ambient declaration for the optional @tensorflow/tfjs-node package. The
 * native TensorFlow runtime is an optional dependency used only by the
 * predictive-model service; this keeps typechecking green without forcing the
 * heavyweight native binary into every install.
 */
declare module '@tensorflow/tfjs-node' {
  export interface LayersModel {
    predict(input: unknown): unknown;
    save(path: string): Promise<unknown>;
    dispose(): void;
  }

  export interface Sequential extends LayersModel {
    add(layer: unknown): void;
    compile(config: object): void;
    fit(x: unknown, y: unknown, config?: object): Promise<unknown>;
  }

  export function loadLayersModel(path: string): Promise<LayersModel>;
  export function sequential(config?: object): Sequential;

  export const layers: {
    lstm(config: object): unknown;
    dropout(config: object): unknown;
    dense(config: object): unknown;
    input(config: object): unknown;
    reshape(config: object): unknown;
  };

  export const train: {
    adam(config?: object): unknown;
  };

  export const tensor2d: {
    (values: number[][], shape?: [number, number]): unknown;
  };

  export const tensor3d: {
    (values: number[][][], shape?: [number, number, number]): unknown;
  };

  export const reshape: {
    (tensor: unknown, shape: number[]): unknown;
  };

  export function ready(): Promise<void>;
}
