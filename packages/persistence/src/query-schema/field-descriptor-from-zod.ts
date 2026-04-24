import { z } from 'zod';
import type {
  FieldDescriptor,
  FieldDescriptorMap,
  FieldKind,
} from '../query/field-descriptor.type.js';

export function fieldDescriptorsFromZod(schema: z.ZodObject<z.ZodRawShape>): FieldDescriptorMap {
  const shape = schema.shape;
  const result: Record<string, FieldDescriptor> = {};
  for (const [key, fieldSchema] of Object.entries(shape)) {
    const descriptor = descriptorFromZodField(fieldSchema as z.ZodType);
    if (descriptor) result[key] = descriptor;
  }
  return result;
}

function descriptorFromZodField(schema: z.ZodType): FieldDescriptor | null {
  const optional = schema instanceof z.ZodOptional;
  const inner = optional ? (schema as z.ZodOptional<z.ZodType>).unwrap() : schema;
  const kind = kindOf(inner);
  if (!kind) return null;
  return optional ? { kind, optional: true } : { kind };
}

function kindOf(schema: z.ZodType): FieldKind | null {
  if (schema instanceof z.ZodString) return 'string';
  if (schema instanceof z.ZodNumber) return 'number';
  if (schema instanceof z.ZodBoolean) return 'boolean';
  if (schema instanceof z.ZodDate) return 'date';
  return null;
}
