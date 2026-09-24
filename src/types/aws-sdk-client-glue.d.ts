/**
 * Ambient declaration for the optional @aws-sdk/client-glue package. AWS Glue
 * catalog registration is an optional data-lake integration; this keeps
 * typechecking green without pulling the SDK into every install.
 */
declare module '@aws-sdk/client-glue' {
  export class GlueClient {
    constructor(config?: { region?: string });
    send(command: unknown): Promise<unknown>;
  }

  export class CreateTableCommand {
    constructor(input: object);
  }

  export class UpdateTableCommand {
    constructor(input: object);
  }

  export class GetTableCommand {
    constructor(input: object);
  }

  export type TableInput = {
    Name?: string;
    StorageDescriptor?: StorageDescriptor;
    PartitionKeys?: Array<{ Name?: string; Type?: string }>;
    TableType?: string;
    Parameters?: Record<string, string>;
  };

  export type StorageDescriptor = {
    Location?: string;
    InputFormat?: string;
    OutputFormat?: string;
    SerdeInfo?: { SerializationLibrary?: string; Parameters?: Record<string, string> };
    Columns?: Array<{ Name?: string; Type?: string }>;
    BucketColumns?: string[];
    SortColumns?: Array<{ Column?: string; SortOrder?: number }>;
    Parameters?: Record<string, string>;
  };
}
