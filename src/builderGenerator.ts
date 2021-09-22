import {
  ClassDeclarationStructure,
  FunctionDeclarationStructure,
  IndentationText,
  InterfaceDeclaration,
  MethodDeclarationStructure,
  Project,
  QuoteKind,
  Scope,
  StructureKind,
  ts,
  Type,
  TypeAliasDeclaration,
} from 'ts-morph';
import * as path from 'path';
import { copyFile } from 'fs/promises';

export async function generateBuilders(
  inputFilePath: string,
  outputFilePath: string,
): Promise<void> {
  const project = new Project({
    manipulationSettings: {
      indentationText: IndentationText.TwoSpaces,
      quoteKind: QuoteKind.Single,
    },
    compilerOptions: {
      strictNullChecks: true,
    },
  });
  project.addSourceFileAtPath(inputFilePath);
  const fileName = path.basename(inputFilePath);
  const fileNameWithoutExtension = path.basename(
    inputFilePath,
    path.extname(inputFilePath),
  );
  const sourceFile = project.getSourceFileOrThrow(fileName);

  project.createDirectory(outputFilePath);

  const allTypes = sourceFile.getTypeAliases();
  const allInterfaces = sourceFile.getInterfaces();

  const classesAndFactories: {
    classObj: ClassDeclarationStructure;
    builderFunc: FunctionDeclarationStructure;
  }[] = [];

  const indexFile = project.createSourceFile(
    path.join(outputFilePath, `index.ts`),
    undefined,
    {
      overwrite: true,
      scriptKind: ts.ScriptKind.TS,
    },
  );

  for (const typeAlias of allTypes) {
    const { classObj, builderFunc } = generateBuilderFunc(typeAlias);
    if (classObj && builderFunc) {
      classesAndFactories.push({
        classObj,
        builderFunc,
      });
    }
  }
  for (const interfaceType of allInterfaces) {
    const { classObj, builderFunc } = generateBuilderFunc(interfaceType);
    if (classObj && builderFunc) {
      classesAndFactories.push({
        classObj,
        builderFunc,
      });
    }
  }

  const promises = classesAndFactories.map(({ classObj, builderFunc }) => {
    const outFile = project.createSourceFile(
      path.join(outputFilePath, `${classObj.name}.ts`),
      undefined,
      {
        overwrite: true,
        scriptKind: ts.ScriptKind.TS,
      },
    );

    outFile.addStatements([
      '/* eslint-disable */',
      {
        kind: StructureKind.ImportDeclaration,
        namedImports: ['DeepPartial'],
        moduleSpecifier: 'ts-essentials',
      },
      {
        kind: StructureKind.ImportDeclaration,
        namespaceImport: 'SchemaTypes',
        moduleSpecifier: `./${fileNameWithoutExtension}`,
      },
    ]);

    indexFile.addExportDeclaration({
      kind: StructureKind.ExportDeclaration,
      moduleSpecifier: `./${classObj.name}`,
    });

    outFile.addClass(classObj);
    outFile.addFunction(builderFunc);

    return outFile
      .save()
      .then(() => copyFile(inputFilePath, `${outputFilePath}/${fileName}`));
  });

  return Promise.all([...promises, indexFile.save()]).then();
}

function generateBuilderFunc(
  typeAlias: TypeAliasDeclaration | InterfaceDeclaration,
) {
  const rootType = typeAlias.getType();

  const props = rootType.getProperties();

  if (props.length <= 0) {
    return {};
  }

  if (rootType.isUnion()) {
    console.warn(`Skipped type generation for union: ${typeAlias.getName()}`);

    return {};
  }

  const objName = 'obj';
  const typeName = typeAlias.getName();
  const className = `${typeName}Builder`;

  const methods: MethodDeclarationStructure[] = [];
  for (const prop of props) {
    const propName = prop.getName();
    if (propName === '__typename') {
      continue;
    }
    const type = prop.getTypeAtLocation(prop.getValueDeclarationOrThrow());

    const unionTypes = type.isUnion() ? type.getUnionTypes() : [type];

    const parametersType = unionTypes
      .map(builderParameterTypeMapper)
      .filter((t) => t !== 'false')
      .map((t) => (t === 'true' ? 'boolean' : t))
      .join(' | ');

    const method: MethodDeclarationStructure = {
      kind: StructureKind.Method,
      name: `with${capitalizeFirstLetter(propName)}`,
      returnType: className,
      typeParameters: [`P extends ${parametersType}`],
      parameters: [{ name: 'val', type: 'P' }],
      scope: Scope.Public,
      statements: [`this.obj.${propName} = val;`, `return this;`],
    };
    methods.push(method);
  }

  methods.push({
    kind: StructureKind.Method,
    name: `includeTypename`,
    scope: Scope.Public,
    statements: [
      '// @ts-ignore',
      `this.obj.__typename = '${typeName}';`,
      `return this;`,
    ],
  });

  methods.push({
    kind: StructureKind.Method,
    name: `get`,
    scope: Scope.Public,
    returnType: `SchemaTypes.${typeName}`,
    statements: `return this.${objName} as SchemaTypes.${typeName};`,
  });

  const builderFunc: FunctionDeclarationStructure = {
    kind: StructureKind.Function,
    name: `a${className}`,
    isExported: true,
    typeParameters: [`O extends DeepPartial<SchemaTypes.${typeName}> = {}`],
    returnType: `${className}`,
    parameters: [
      {
        name: 'baseObj',
        type: `O`,
        hasQuestionToken: true,
      },
    ],
    statements: `return new ${className}(baseObj ?? {});`,
  };

  const classObj: ClassDeclarationStructure = {
    kind: StructureKind.Class,
    name: className,
    ctors: [
      {
        kind: StructureKind.Constructor,
        parameters: [
          {
            name: objName,
            initializer: `{} as DeepPartial<SchemaTypes.${typeName}>`,
            isReadonly: true,
            scope: Scope.Private,
          },
        ],
      },
    ],
    methods,
    isExported: true,
  };

  return { builderFunc, classObj };
}

function builderParameterTypeMapper(subType: Type): string {
  const isArray = subType.isArray();

  const resultType = isArray ? subType.getArrayElementType()! : subType;

  const isPrimitive = [
    resultType.isString(),
    resultType.isNumber(),
    resultType.isLiteral(),
    resultType.isBoolean(),
    resultType.isUndefined(),
    resultType.isNull(),
    resultType.isAny(),
    resultType.isEnum(),
  ].some(Boolean);

  let resultTypeStr = resultType
    .getText()
    .replace(/import\("[^"]*"\)/gi, 'SchemaTypes');

  resultTypeStr = isPrimitive
    ? `${resultTypeStr}`
    : `DeepPartial<${resultTypeStr}>`;

  return isArray ? `${resultTypeStr}[]` : resultTypeStr;
}

function capitalizeFirstLetter(string: string) {
  return string.charAt(0).toUpperCase() + string.slice(1);
}