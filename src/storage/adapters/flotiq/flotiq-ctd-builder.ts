export type FieldSettings =
  | {
      type: "string";
      label: string;
      helpText?: string;
      required: boolean;
      unique?: boolean;
      multiple?: boolean;
      default?: string;
      allowedValues?: string[];
      partOfTitle?: boolean;
      isPassword?: boolean;
      inputType?: "textMarkdown" | "textarea";
      readonly?: boolean;
      hidden?: boolean;
    }
  | {
      type: "number";
      label: string;
      helpText?: string;
      required: boolean;
      unique?: boolean;
      default?: number;
      partOfTitle?: boolean;
      readonly?: boolean;
      hidden?: boolean;
    }
  | {
      type: "boolean";
      label: string;
      helpText?: string;
      required: boolean;
      default?: boolean;
      partOfTitle?: boolean;
      readonly?: boolean;
      hidden?: boolean;
    }
  | {
      type: "datasource";
      label: string;
      helpText?: string;
      required: boolean;
      unique?: boolean;
      multiple?: boolean;
      relationContentType: string;
      readonly?: boolean;
      hidden?: boolean;
    };

export type FieldsDescriptor = Record<string, FieldSettings>;

/* example ctds:

{
  "id": "1efa7f4d-4517-6fb8-929d-cde860c52932",
  "name": "test_type_fields",
  "label": "Test/type fields",
  "draftPublic": true,
  "autoSave": false,
  "internal": false,
  "schemaDefinition": {
    "allOf": [
      {
        "$ref": "#/components/schemas/AbstractContentTypeSchemaDefinition",
        "type": null
      },
      {
        "properties": {
          "v": {
            "default": 0.123,
            "type": "number"
          },
          "any_rel": {
            "items": {
              "$ref": "#/components/schemas/DataSource",
              "type": null
            },
            "type": "array"
          },
          "radiiiio": {
            "type": "string"
          },
          "geo_stuff": {
            "default": {
              "lat": 49.4861179,
              "lon": 22.2241037
            },
            "properties": {
              "lat": {
                "maximum": 90,
                "minimum": -90,
                "type": "number"
              },
              "lon": {
                "maximum": 180,
                "minimum": -180,
                "type": "number"
              }
            },
            "additionalProperties": false,
            "type": "object"
          },
          "lista_hihi": {
            "items": {
              "required": [
                "reqtext"
              ],
              "properties": {
                "text": {
                  "type": "string"
                },
                "reqtext": {
                  "type": "string"
                }
              },
              "type": "object"
            },
            "type": "array"
          },
          "simplelist": {
            "items": {
              "type": "string"
            },
            "type": "array"
          },
          "multiselect": {
            "items": {
              "type": "string"
            },
            "type": "array"
          },
          "nesta_lista": {
            "items": {
              "properties": {
                "nesta_lista_list": {
                  "items": {
                    "properties": {
                      "some_geo": {
                        "properties": {
                          "lat": {
                            "maximum": 90,
                            "minimum": -90,
                            "type": "number"
                          },
                          "lon": {
                            "maximum": 180,
                            "minimum": -180,
                            "type": "number"
                          }
                        },
                        "additionalProperties": false,
                        "type": "object"
                      },
                      "sometext": {
                        "type": "string"
                      },
                      "some_relation": {
                        "items": {
                          "$ref": "#/components/schemas/DataSource",
                          "type": null
                        },
                        "type": "array"
                      },
                      "nesta_lista_media_rel": {
                        "items": {
                          "$ref": "#/components/schemas/DataSource",
                          "type": null
                        },
                        "type": "array"
                      }
                    },
                    "type": "object"
                  },
                  "type": "array"
                },
                "nesta_lista_name": {
                  "type": "string"
                },
                "nesta_lista_relation": {
                  "items": {
                    "$ref": "#/components/schemas/DataSource",
                    "type": null
                  },
                  "type": "array"
                }
              },
              "type": "object"
            },
            "type": "array"
          },
          "blocky_stuff": {
            "default": {
              "time": 1732185413372,
              "blocks": [],
              "version": "2.29.0"
            },
            "properties": {
              "time": {
                "type": "number"
              },
              "blocks": {
                "items": {
                  "properties": {
                    "data": {
                      "properties": {
                        "text": {
                          "type": "string"
                        }
                      },
                      "additionalProperties": true,
                      "type": "object"
                    },
                    "type": {
                      "type": "string"
                    }
                  },
                  "type": "object"
                },
                "type": "array"
              },
              "version": {
                "type": "string"
              }
            },
            "additionalProperties": false,
            "type": "object"
          },
          "simple_select": {
            "type": "string"
          }
        },
        "type": "object"
      }
    ],
    "required": [],
    "additionalProperties": false,
    "type": "object"
  },
  "metaDefinition": {
    "order": [
      "geo_stuff",
      "blocky_stuff",
      "simplelist",
      "multiselect",
      "simple_select",
      "radiiiio",
      "lista_hihi",
      "any_rel",
      "nesta_lista",
      "v"
    ],
    "propertiesConfig": {
      "v": {
        "label": "v",
        "inputType": "number",
        "unique": false,
        "helpText": ""
      },
      "any_rel": {
        "label": "Any Rel",
        "inputType": "datasource",
        "unique": false,
        "validation": {
          "relationMultiple": true,
          "relationContenttype": ""
        },
        "helpText": "Jaka\u015btam relacja"
      },
      "radiiiio": {
        "label": "Radiiiio",
        "inputType": "radio",
        "unique": false,
        "options": [
          "r1",
          "r2",
          "r3"
        ],
        "helpText": ""
      },
      "geo_stuff": {
        "label": "Geo stuff",
        "inputType": "geo",
        "unique": false,
        "helpText": ""
      },
      "lista_hihi": {
        "label": "Lista hihi",
        "inputType": "object",
        "unique": false,
        "helpText": "",
        "items": {
          "order": [
            "reqtext",
            "text"
          ],
          "propertiesConfig": {
            "text": {
              "label": "text",
              "inputType": "text",
              "unique": false,
              "helpText": ""
            },
            "reqtext": {
              "label": "reqtext",
              "inputType": "text",
              "unique": false,
              "helpText": ""
            }
          }
        }
      },
      "simplelist": {
        "label": "Simplelist",
        "inputType": "simpleList",
        "unique": false,
        "helpText": ""
      },
      "multiselect": {
        "label": "Multiselect",
        "inputType": "select",
        "unique": false,
        "options": [
          "a1",
          "a2",
          "a3"
        ],
        "useOptionsWithLabels": false,
        "helpText": "",
        "multiple": true
      },
      "nesta_lista": {
        "label": "Nesta Lista",
        "inputType": "object",
        "unique": false,
        "helpText": "",
        "items": {
          "order": [
            "nesta_lista_name",
            "nesta_lista_relation",
            "nesta_lista_list"
          ],
          "propertiesConfig": {
            "nesta_lista_list": {
              "label": "Nesta Lista List",
              "inputType": "object",
              "unique": false,
              "helpText": "Lista ze zbyt du\u017c\u0105 ilo\u015bci\u0105 zagnie\u017cd\u017ce\u0144  relacji",
              "items": {
                "order": [
                  "sometext",
                  "some_geo",
                  "some_relation",
                  "nesta_lista_media_rel"
                ],
                "propertiesConfig": {
                  "some_geo": {
                    "label": "some geo",
                    "inputType": "geo",
                    "unique": false,
                    "helpText": ""
                  },
                  "sometext": {
                    "label": "sometext",
                    "inputType": "text",
                    "unique": false,
                    "helpText": ""
                  },
                  "some_relation": {
                    "label": "some relation",
                    "inputType": "datasource",
                    "unique": false,
                    "validation": {
                      "relationMultiple": false,
                      "relationContenttype": ""
                    },
                    "helpText": ""
                  },
                  "nesta_lista_media_rel": {
                    "label": "nesta lista media rel",
                    "inputType": "datasource",
                    "unique": false,
                    "validation": {
                      "relationMultiple": false,
                      "relationContenttype": ""
                    },
                    "helpText": ""
                  }
                }
              }
            },
            "nesta_lista_name": {
              "label": "Nesta Lista Name",
              "inputType": "text",
              "unique": false,
              "helpText": ""
            },
            "nesta_lista_relation": {
              "label": "Nesta Lista Relation",
              "inputType": "datasource",
              "unique": false,
              "validation": {
                "relationMultiple": false,
                "relationContenttype": ""
              },
              "helpText": ""
            }
          }
        }
      },
      "blocky_stuff": {
        "label": "Blocky stuff",
        "inputType": "block",
        "unique": false,
        "helpText": ""
      },
      "simple_select": {
        "label": "Simple Select",
        "inputType": "select",
        "unique": false,
        "options": [
          "a1",
          "b2",
          "c3"
        ],
        "useOptionsWithLabels": false,
        "helpText": ""
      }
    }
  },
  "featuredImage": [],
  "deletedAt": null,
  "createdAt": "2024-11-21T10:39:04.000000+0000",
  "updatedAt": "2026-04-13T13:22:49.000000+0000"
}
  {
  "id": "a6538174-2506-11ea-b06e-aa5dde16c881",
  "name": "blogpost",
  "label": "Blog Post",
  "draftPublic": true,
  "autoSave": false,
  "internal": false,
  "schemaDefinition": {
    "allOf": [
      {
        "$ref": "#/components/schemas/AbstractContentTypeSchemaDefinition",
        "type": null
      },
      {
        "properties": {
          "slug": {
            "type": "string"
          },
          "image": {
            "items": {
              "$ref": "#/components/schemas/DataSource",
              "type": null
            },
            "type": "array"
          },
          "title": {
            "type": "string"
          },
          "exerpt": {
            "type": "string"
          },
          "rich_text": {
            "type": "string"
          },
          "__translations": {
            "items": {
              "required": [
                "title",
                "__language"
              ],
              "properties": {
                "slug": {
                  "type": "string"
                },
                "image": {
                  "items": {
                    "$ref": "#/components/schemas/DataSource",
                    "type": null
                  },
                  "type": "array"
                },
                "title": {
                  "type": "string"
                },
                "exerpt": {
                  "type": "string"
                },
                "rich_text": {
                  "type": "string"
                },
                "__language": {
                  "default": "en",
                  "type": "string"
                },
                "published_date": {
                  "pattern": "^$|^([12]\\d{3}-(0[1-9]|1[0-2])-(0[1-9]|[12]\\d|3[01]))T?(([0-1]?[0-9]|2[0-3]):[0-5][0-9])?(:[0-5][0-9])?(\\.[0-9]{3})?(Z|([\\+-]\\d{2}(:\\d{2})?))?$",
                  "type": "string"
                }
              },
              "type": "object"
            },
            "type": "array"
          },
          "published_date": {
            "pattern": "^$|^([12]\\d{3}-(0[1-9]|1[0-2])-(0[1-9]|[12]\\d|3[01]))T?(([0-1]?[0-9]|2[0-3]):[0-5][0-9])?(:[0-5][0-9])?(\\.[0-9]{3})?(Z|([\\+-]\\d{2}(:\\d{2})?))?$",
            "type": "string"
          }
        },
        "type": "object"
      }
    ],
    "required": [
      "title"
    ],
    "additionalProperties": false,
    "type": "object"
  },
  "metaDefinition": {
    "order": [
      "slug",
      "title",
      "published_date",
      "exerpt",
      "image",
      "rich_text",
      "__translations"
    ],
    "propertiesConfig": {
      "slug": {
        "label": "Slug",
        "inputType": "text",
        "unique": false,
        "helpText": ""
      },
      "image": {
        "label": "Image",
        "inputType": "datasource",
        "unique": false,
        "validation": {
          "relationMultiple": true,
          "relationContenttype": ""
        },
        "helpText": ""
      },
      "title": {
        "label": "Title",
        "inputType": "text",
        "unique": false,
        "helpText": "",
        "isTitlePart": true
      },
      "exerpt": {
        "label": "Exerpt",
        "inputType": "textarea",
        "unique": false,
        "helpText": ""
      },
      "rich_text": {
        "label": "rich text",
        "inputType": "richtext",
        "unique": false,
        "helpText": ""
      },
      "__translations": {
        "label": "Translations",
        "inputType": "object",
        "unique": false,
        "hidden": true,
        "helpText": "",
        "items": {
          "order": [
            "slug",
            "title",
            "published_date",
            "exerpt",
            "image",
            "rich_text",
            "__language"
          ],
          "propertiesConfig": {
            "slug": {
              "label": "Slug",
              "inputType": "text",
              "unique": false,
              "helpText": ""
            },
            "image": {
              "label": "Image",
              "inputType": "datasource",
              "unique": false,
              "validation": {
                "relationMultiple": true,
                "relationContenttype": ""
              },
              "helpText": ""
            },
            "title": {
              "label": "Title",
              "inputType": "text",
              "unique": false,
              "helpText": "",
              "isTitlePart": true
            },
            "exerpt": {
              "label": "Exerpt",
              "inputType": "textarea",
              "unique": false,
              "helpText": ""
            },
            "rich_text": {
              "label": "rich text",
              "inputType": "richtext",
              "unique": false,
              "helpText": ""
            },
            "__language": {
              "label": "Language",
              "inputType": "text",
              "unique": false,
              "helpText": ""
            },
            "published_date": {
              "label": "Published date",
              "inputType": "dateTime",
              "unique": false,
              "helpText": ""
            }
          }
        }
      },
      "published_date": {
        "label": "Published date",
        "inputType": "dateTime",
        "unique": false,
        "helpText": ""
      }
    }
  },
  "featuredImage": [],
  "deletedAt": null,
  "createdAt": "2019-12-22T22:01:47.000000+0000",
  "updatedAt": "2026-04-14T10:50:12.000000+0000"
}
  */

type FieldSchema = {
  type: string | null;
  items?: FieldSchema;
  properties?: Record<string, FieldSchema>;
  default?: string | number | boolean | string[];
  $ref?: string;
};

type FieldMeta = {
  label: string;
  inputType: string;
  helpText: string;
  unique?: boolean;
  options?: string[];
  multiple?: boolean;
  useOptionsWithLabels?: boolean;
  isPassword?: boolean;
  readonly?: boolean;
  isTitlePart?: boolean;
  hidden?: boolean;
  validation?: {
    relationMultiple: boolean;
    relationContenttype: string;
  };
};

function buildFieldInfo(field: FieldSettings) {
  switch (field.type) {
    case "string":
      return buildStringFieldInfo(field);
    case "number":
      return buildNumberFieldInfo(field);
    case "boolean":
      return buildBooleanFieldInfo(field);
    case "datasource":
      return buildDatasourceFieldInfo(field);
  }

  throw new Error(
    `Unsupported field type: ${(field as FieldSettings).type as string}`,
  );
}

function buildStringFieldInfo(
  field: Extract<FieldSettings, { type: "string" }>,
) {
  const schema: FieldSchema = { type: "string" };
  const meta: FieldMeta = {
    label: field.label,
    inputType: field.inputType ?? "text",
    helpText: field.helpText ?? "",
    unique: field.unique ?? false,
    isPassword: field.isPassword ?? false,
    readonly: field.readonly ?? false,
    isTitlePart: field.partOfTitle ?? false,
    hidden: field.hidden ?? false,
  };

  if (field.multiple) {
    schema.type = "array";
    schema.items = { type: "string" };
    meta.inputType = "simpleList";
  }

  if (field.allowedValues) {
    applyAllowedValuesMeta(field, meta);
  }

  if (field.default !== undefined) {
    schema.default = field.default;
  }

  return { schema, meta };
}

function buildNumberFieldInfo(
  field: Extract<FieldSettings, { type: "number" }>,
) {
  const schema: FieldSchema = { type: "number" };
  const meta: FieldMeta = {
    label: field.label,
    inputType: "number",
    helpText: field.helpText ?? "",
    unique: field.unique ?? false,
    readonly: field.readonly ?? false,
    isTitlePart: field.partOfTitle ?? false,
    hidden: field.hidden ?? false,
  };

  if (field.default !== undefined) {
    schema.default = field.default;
  }

  return { schema, meta };
}

function buildBooleanFieldInfo(
  field: Extract<FieldSettings, { type: "boolean" }>,
) {
  const schema: FieldSchema = { type: "boolean" };
  const meta: FieldMeta = {
    label: field.label,
    inputType: "checkbox",
    helpText: field.helpText ?? "",
    unique: false,
    readonly: field.readonly ?? false,
    isTitlePart: field.partOfTitle ?? false,
    hidden: field.hidden ?? false,
  };

  if (field.default !== undefined) {
    schema.default = field.default;
  }

  return { schema, meta };
}

function buildDatasourceFieldInfo(
  field: Extract<FieldSettings, { type: "datasource" }>,
) {
  return {
    schema: {
      type: "array",
      items: {
        $ref: "#/components/schemas/DataSource",
        type: null,
      },
    } satisfies FieldSchema,
    meta: {
      label: field.label,
      inputType: "datasource",
      helpText: field.helpText ?? "",
      unique: field.unique ?? false,
      readonly: field.readonly ?? false,
      hidden: field.hidden ?? false,
      validation: {
        relationMultiple: field.multiple ?? false,
        relationContenttype: field.relationContentType,
      },
    } satisfies FieldMeta,
  };
}

function applyAllowedValuesMeta(
  field: Extract<FieldSettings, { type: "string" }>,
  meta: FieldMeta,
): void {
  if (!field.allowedValues) {
    return;
  }

  if (field.multiple) {
    meta.inputType = "select";
    meta.options = field.allowedValues;
    meta.useOptionsWithLabels = false;
    return;
  }

  meta.inputType = "radio";
  meta.options = field.allowedValues;
}

export function generateCtdFromFieldsDescriptor(
  name: string,
  label: string,
  fieldsDescriptor: FieldsDescriptor,
) {
  const propertiesConfig: Record<string, FieldMeta> = {};
  const fieldSchemas: Record<string, FieldSchema> = {};

  const requiredFields: string[] = [];
  for (const [fieldName, settings] of Object.entries(fieldsDescriptor)) {
    const { schema, meta } = buildFieldInfo(settings);
    fieldSchemas[fieldName] = schema;
    propertiesConfig[fieldName] = meta;
    if (settings.required) {
      requiredFields.push(fieldName);
    }
  }

  return {
    name,
    label,
    schemaDefinition: {
      allOf: [
        {
          $ref: "#/components/schemas/AbstractContentTypeSchemaDefinition",
          type: null,
        },
        {
          properties: fieldSchemas,
          type: "object",
        },
      ],
      required: requiredFields,
      type: "object",
      additionalProperties: false,
    },
    metaDefinition: {
      order: Object.keys(fieldsDescriptor),
      propertiesConfig: propertiesConfig,
    },
  };
}

export type CtdDefinition = ReturnType<typeof generateCtdFromFieldsDescriptor>;
