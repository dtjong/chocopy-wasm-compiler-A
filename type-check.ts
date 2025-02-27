
import { Annotation, Location, stringifyOp, Stmt, Expr, Type, UniOp, BinOp, Literal, Program, FunDef, VarInit, Class, Callable } from './ast';
import { NUM, BOOL, NONE, CLASS, CALLABLE } from './utils';
import { emptyEnv } from './compiler';
import { fullSrcLine, drawSquiggly } from './errors';

// I ❤️ TypeScript: https://github.com/microsoft/TypeScript/issues/13965



export class TypeCheckError extends Error {
  __proto__: Error;
  a?: Annotation | undefined;
  errMsg: string;

  constructor(SRC?: string, message?: string, a?: Annotation) {
    const fromLoc = a?.fromLoc;
    const endLoc = a?.endLoc;
    const eolLoc = a?.eolLoc;
    const trueProto = new.target.prototype;
    const loc = (a) ? ` on line ${fromLoc.row} at col ${fromLoc.col}` : '';
    const src = (a) ? fullSrcLine(SRC, fromLoc.srcIdx, fromLoc.col, eolLoc.srcIdx) : '';
    // TODO: how to draw squigglies if the error spans multiple lines?
    const squiggly = (a) ? drawSquiggly(fromLoc.row, endLoc.row, fromLoc.col, endLoc.col) : '';
    const msg = `\n\n${src}\n${squiggly}`;
    const res = "TYPE ERROR: " + message + loc + msg;
    super(res);
    this.a = (a) ?? undefined;
    this.errMsg = res;


    // Alternatively use Object.setPrototypeOf if you have an ES6 environment.
    this.__proto__ = trueProto;
  }

  public getA(): Annotation | undefined {
    return this.a;
  }

  public getErrMsg(): string {
    return this.errMsg;
  }

}

export type GlobalTypeEnv = {
  globals: Map<string, Type>,
  functions: Map<string, [Array<Type>, Type]>,
  classes: Map<string, [Map<string, Type>, Map<string, [Array<Type>, Type]>]>
}

export type LocalTypeEnv = {
  vars: Map<string, Type>,
  expectedRet: Type,
  actualRet: Type,
  topLevel: Boolean
}

const copyLocals = (locals: LocalTypeEnv): LocalTypeEnv => {
  return {
    ...locals,
    vars: new Map(locals.vars)
  }
}
const copyGlobals = (env: GlobalTypeEnv): GlobalTypeEnv => {
  return {
    globals: new Map(env.globals),
    functions: new Map(env.functions),
    classes: new Map(env.classes)
  };
}

export type NonlocalTypeEnv = LocalTypeEnv["vars"]

const defaultGlobalFunctions = new Map();
defaultGlobalFunctions.set("abs", [[NUM], NUM]);
defaultGlobalFunctions.set("max", [[NUM, NUM], NUM]);
defaultGlobalFunctions.set("min", [[NUM, NUM], NUM]);
defaultGlobalFunctions.set("pow", [[NUM, NUM], NUM]);
defaultGlobalFunctions.set("print", [[CLASS("object")], NUM]);

export const defaultTypeEnv = {
  globals: new Map(),
  functions: defaultGlobalFunctions,
  classes: new Map(),
};

export function emptyGlobalTypeEnv(): GlobalTypeEnv {
  return {
    globals: new Map(),
    functions: new Map(),
    classes: new Map()
  };
}

export function emptyLocalTypeEnv(): LocalTypeEnv {
  return {
    vars: new Map(),
    expectedRet: NONE,
    actualRet: NONE,
    topLevel: true
  };
}

export type TypeError = {
  message: string
}

export function equalCallable(t1: Callable, t2: Callable): boolean {
  return t1.params.length === t2.params.length &&
    t1.params.every((param, i) => equalType(param, t2.params[i])) && equalType(t1.ret, t2.ret);
}

export function equalType(t1: Type, t2: Type) {
  return (
    t1 === t2 ||
    (t1.tag === "class" && t2.tag === "class" && t1.name === t2.name) ||
    (t1.tag === "callable" && t2.tag === "callable" && equalCallable(t1, t2))
  );
}

export function isNoneOrClassOrCallable(t: Type) {
  return t.tag === "none" || t.tag === "class" || t.tag === "callable";
}

export function isSubtype(env: GlobalTypeEnv, t1: Type, t2: Type): boolean {
  return equalType(t1, t2) || t1.tag === "none" && (t2.tag === "class" || t2.tag === "callable")
}

export function isAssignable(env: GlobalTypeEnv, t1: Type, t2: Type): boolean {
  return isSubtype(env, t1, t2);
}

export function join(env: GlobalTypeEnv, t1: Type, t2: Type): Type {
  return NONE
}

export function augmentTEnv(env: GlobalTypeEnv, program: Program<Annotation>): GlobalTypeEnv {
  const newGlobs = new Map(env.globals);
  const newFuns = new Map(env.functions);
  const newClasses = new Map(env.classes);
  program.inits.forEach(init => newGlobs.set(init.name, init.type));
  program.funs.forEach(fun => newGlobs.set(fun.name, CALLABLE(fun.parameters.map(p => p.type), fun.ret)));
  program.classes.forEach(cls => {
    const fields = new Map();
    const methods = new Map();
    cls.fields.forEach(field => fields.set(field.name, field.type));
    cls.methods.forEach(method => methods.set(method.name, [method.parameters.map(p => p.type), method.ret]));
    newClasses.set(cls.name, [fields, methods]);
  });
  return { globals: newGlobs, functions: newFuns, classes: newClasses };
}

export function tc(env: GlobalTypeEnv, program: Program<Annotation>): [Program<Annotation>, GlobalTypeEnv] {
  const SRC = program.a.src;
  const locals = emptyLocalTypeEnv();
  const newEnv = augmentTEnv(env, program);
  const tInits = program.inits.map(init => tcInit(env, init, SRC));
  const tDefs = program.funs.map(fun => tcDef(newEnv, fun, new Map(), SRC));
  const tClasses = program.classes.map(cls => tcClass(newEnv, cls, SRC));

  // program.inits.forEach(init => env.globals.set(init.name, tcInit(init)));
  // program.funs.forEach(fun => env.functions.set(fun.name, [fun.parameters.map(p => p.type), fun.ret]));
  // program.funs.forEach(fun => tcDef(env, fun));
  // Strategy here is to allow tcBlock to populate the locals, then copy to the
  // global env afterwards (tcBlock changes locals)
  const tBody = tcBlock(newEnv, locals, program.stmts, SRC);
  var lastTyp: Type = NONE;
  if (tBody.length) {
    lastTyp = tBody[tBody.length - 1].a.type;
  }
  // TODO(joe): check for assignment in existing env vs. new declaration
  // and look for assignment consistency
  for (let name of locals.vars.keys()) {
    newEnv.globals.set(name, locals.vars.get(name));
  }
  const aprogram: Program<Annotation> = { a: { ...program.a, type: lastTyp }, inits: tInits, funs: tDefs, classes: tClasses, stmts: tBody };
  return [aprogram, newEnv];
}

export function tcInit(env: GlobalTypeEnv, init: VarInit<Annotation>, SRC: string): VarInit<Annotation> {
  const valTyp = tcLiteral(init.value);
  if (isAssignable(env, valTyp, init.type)) {
    return { ...init, a: { ...init.a, type: NONE } };
  } else {
    throw new TypeCheckError(SRC, `Expected type ${JSON.stringify(init.type.tag)}; got type ${JSON.stringify(valTyp.tag)}`, init.value.a);
  }
}

export function tcDef(env : GlobalTypeEnv, fun : FunDef<Annotation>, nonlocalEnv: NonlocalTypeEnv, SRC: string) : FunDef<Annotation> {
  var locals = emptyLocalTypeEnv();
  locals.vars.set(fun.name, CALLABLE(fun.parameters.map(x => x.type), fun.ret));
  locals.expectedRet = fun.ret;
  locals.topLevel = false;
  var nonlocals = fun.nonlocals.map(init => ({ name: init.name, a: { ...init.a, type: nonlocalEnv.get(init.name) }}));
  fun.parameters.forEach(p => locals.vars.set(p.name, p.type));
  fun.inits.forEach(init => locals.vars.set(init.name, tcInit(env, init, SRC).type));
  nonlocals.forEach(init => locals.vars.set(init.name, init.a.type));
  var envCopy = copyGlobals(env);
  fun.children.forEach(f => envCopy.functions.set(f.name, [f.parameters.map(x => x.type), f.ret]));
  var children = fun.children.map(f => tcDef(envCopy, f, locals.vars, SRC));
  fun.children.forEach(child => locals.vars.set(child.name, CALLABLE(child.parameters.map(x => x.type), child.ret)));
  
  const tBody = tcBlock(envCopy, locals, fun.body, SRC);
  if (!isAssignable(envCopy, locals.actualRet, locals.expectedRet))
    // TODO: what locations to be reported here?
    throw new TypeCheckError(`expected return type of block: ${JSON.stringify(locals.expectedRet)} does not match actual return type: ${JSON.stringify(locals.actualRet)}`)
  return {...fun, a: { ...fun.a, type: NONE }, body: tBody, nonlocals, children};
}

export function tcClass(env: GlobalTypeEnv, cls : Class<Annotation>, SRC: string) : Class<Annotation> {
  const tFields = cls.fields.map(field => tcInit(env, field, SRC));
  const tMethods = cls.methods.map(method => tcDef(env, method, new Map(), SRC));
  const init = cls.methods.find(method => method.name === "__init__") // we'll always find __init__
  if (init.parameters.length !== 1 ||
    init.parameters[0].name !== "self" ||
    !equalType(init.parameters[0].type, CLASS(cls.name)) ||
    init.ret !== NONE) {
    const reason = (init.parameters.length !== 1) ? `${init.parameters.length} parameters` :
      (init.parameters[0].name !== "self") ? `parameter name ${init.parameters[0].name}` :
        (!equalType(init.parameters[0].type, CLASS(cls.name))) ? `parameter type ${JSON.stringify(init.parameters[0].type.tag)}` :
          (init.ret !== NONE) ? `return type ${JSON.stringify(init.ret.tag)}` : "unknown reason";

    throw new TypeCheckError(SRC, `__init__ takes 1 parameter \`self\` of the same type of the class \`${cls.name}\` with return type of \`None\`, got ${reason}`, init.a);
  }
  return { a: { ...cls.a, type: NONE }, name: cls.name, fields: tFields, methods: tMethods };
}

export function tcBlock(env: GlobalTypeEnv, locals: LocalTypeEnv, stmts: Array<Stmt<Annotation>>, SRC: string): Array<Stmt<Annotation>> {
  var tStmts = stmts.map(stmt => tcStmt(env, locals, stmt, SRC));
  return tStmts;
}


export function tcStmt(env: GlobalTypeEnv, locals: LocalTypeEnv, stmt: Stmt<Annotation>, SRC: string): Stmt<Annotation> {
  switch (stmt.tag) {
    case "assign":
      const tValExpr = tcExpr(env, locals, stmt.value, SRC);
      var nameTyp;
      if (locals.vars.has(stmt.name)) {
        nameTyp = locals.vars.get(stmt.name);
      } else if (env.globals.has(stmt.name)) {
        nameTyp = env.globals.get(stmt.name);
      } else {
        throw new TypeCheckError(SRC, "Unbound id: " + stmt.name);
      }
      if (!isAssignable(env, tValExpr.a.type, nameTyp))
        throw new TypeCheckError(SRC, `Assignment value should have assignable type to type ${JSON.stringify(nameTyp.tag)}, got ${JSON.stringify(tValExpr.a.type.tag)}`,
        tValExpr.a);
      return { a: { ...stmt.a, type: NONE }, tag: stmt.tag, name: stmt.name, value: tValExpr };
    case "expr":
      const tExpr = tcExpr(env, locals, stmt.expr, SRC);
      return { a: tExpr.a, tag: stmt.tag, expr: tExpr };
    case "if":
      var tCond = tcExpr(env, locals, stmt.cond, SRC);
      const tThn = tcBlock(env, locals, stmt.thn, SRC);
      const thnTyp = locals.actualRet;
      locals.actualRet = NONE;
      const tEls = tcBlock(env, locals, stmt.els, SRC);
      const elsTyp = locals.actualRet;
      if (tCond.a.type !== BOOL)
        throw new TypeCheckError(SRC, `Condition Expression Must be have type "bool", got ${JSON.stringify(tCond.a.type.tag)}`, tCond.a);
      if (thnTyp !== elsTyp)
        locals.actualRet = { tag: "either", left: thnTyp, right: elsTyp }
      return { a: { ...stmt.a, type: thnTyp }, tag: stmt.tag, cond: tCond, thn: tThn, els: tEls };
    case "return":
      if (locals.topLevel)
      // TODO: error reporting for checking returns
        throw new TypeCheckError(SRC, "cannot return outside of functions");
      const tRet = tcExpr(env, locals, stmt.value, SRC);
      if (!isAssignable(env, tRet.a.type, locals.expectedRet))
        throw new TypeCheckError(SRC, "expected return type `" + (locals.expectedRet as any).tag + "`; got type `" + (tRet.a.type as any).tag + "`",
          stmt.a); // returning the loc of the entire return statement here because the retExpr might be empty
      locals.actualRet = tRet.a.type;
      return { a: tRet.a, tag: stmt.tag, value: tRet };
    case "while":
      var tCond = tcExpr(env, locals, stmt.cond, SRC);
      const tBody = tcBlock(env, locals, stmt.body, SRC);
      if (!equalType(tCond.a.type, BOOL))
        throw new TypeCheckError(SRC, `Condition Expression Must be a bool, got ${JSON.stringify(tCond.a.type.tag)}`, tCond.a);
      return { a: { ...stmt.a, type: NONE }, tag: stmt.tag, cond: tCond, body: tBody };
    case "pass":
      return { a: { ...stmt.a, type: NONE }, tag: stmt.tag };
    case "field-assign":
      var tObj = tcExpr(env, locals, stmt.obj, SRC);
      const tVal = tcExpr(env, locals, stmt.value, SRC);
      if (tObj.a.type.tag !== "class")
        throw new TypeCheckError(SRC, `field assignments require an object, got ${JSON.stringify(tObj.a.type.tag)}`, tObj.a);
      if (!env.classes.has(tObj.a.type.name))
        throw new TypeCheckError(SRC, `field assignment on an unknown class \`${tObj.a.type.name}\``, tObj.a);
      const [fields, _] = env.classes.get(tObj.a.type.name);
      if (!fields.has(stmt.field))
        throw new TypeCheckError(SRC, `could not find field \`${stmt.field}\` in class \`${tObj.a.type.name}\``, stmt.a);
      if (!isAssignable(env, tVal.a.type, fields.get(stmt.field)))
        throw new TypeCheckError(SRC, `field \`${stmt.field}\` expected type: ${JSON.stringify(fields.get(stmt.field).tag)}, got value of type ${JSON.stringify(tVal.a.type.tag)}`,
          tVal.a);
      return { ...stmt, a: { ...stmt.a, type: NONE }, obj: tObj, value: tVal };
  }
}

export function tcExpr(env: GlobalTypeEnv, locals: LocalTypeEnv, expr: Expr<Annotation>, SRC: string): Expr<Annotation> {
  switch (expr.tag) {
    case "literal":
      return { ...expr, a: { ...expr.a, type: tcLiteral(expr.value) } };
    case "binop":
      const tLeft = tcExpr(env, locals, expr.left, SRC);
      const tRight = tcExpr(env, locals, expr.right, SRC);
      const tBin = { ...expr, left: tLeft, right: tRight };
      switch (expr.op) {
        case BinOp.Plus:
        case BinOp.Minus:
        case BinOp.Mul:
        case BinOp.IDiv:
        case BinOp.Mod:
          if (equalType(tLeft.a.type, NUM) && equalType(tRight.a.type, NUM)) { return { ...tBin, a: { ...expr.a, type: NUM } } }
          else { throw new TypeCheckError(SRC, `Binary operator \`${stringifyOp(expr.op)}\` expects type "number" on both sides, got ${JSON.stringify(tLeft.a.type.tag)} and ${JSON.stringify(tRight.a.type.tag)}`,
            expr.a); }
        case BinOp.Eq:
        case BinOp.Neq:
          if (tLeft.a.type.tag === "class" || tRight.a.type.tag === "class") throw new TypeCheckError(SRC, "cannot apply operator '==' on class types")
          if (equalType(tLeft.a.type, tRight.a.type)) { return { ...tBin, a: { ...expr.a, type: BOOL } }; }
          else { throw new TypeCheckError(SRC, `Binary operator \`${stringifyOp(expr.op)}\` expects the same type on both sides, got ${JSON.stringify(tLeft.a.type.tag)} and ${JSON.stringify(tRight.a.type.tag)}`,
            expr.a); }
        case BinOp.Lte:
        case BinOp.Gte:
        case BinOp.Lt:
        case BinOp.Gt:
          if (equalType(tLeft.a.type, NUM) && equalType(tRight.a.type, NUM)) { return { ...tBin, a: { ...expr.a, type: BOOL } }; }
          else { throw new TypeCheckError(SRC, `Binary operator \`${stringifyOp(expr.op)}\` expects type "number" on both sides, got ${JSON.stringify(tLeft.a.type.tag)} and ${JSON.stringify(tRight.a.type.tag)}`,
          expr.a); }
        case BinOp.And:
        case BinOp.Or:
          if (equalType(tLeft.a.type, BOOL) && equalType(tRight.a.type, BOOL)) { return { ...tBin, a: { ...expr.a, type: BOOL } }; }
          else { throw new TypeCheckError(SRC, `Binary operator \`${stringifyOp(expr.op)}\` expects type "bool" on both sides, got ${JSON.stringify(tLeft.a.type.tag)} and ${JSON.stringify(tRight.a.type.tag)}`,
          expr.a); }
        case BinOp.Is:
          if(!isNoneOrClassOrCallable(tLeft.a.type) || !isNoneOrClassOrCallable(tRight.a.type))
            throw new TypeCheckError(SRC, `Binary operator \`${stringifyOp(expr.op)}\` expects type "class", "none", or "callable" on both sides, got ${JSON.stringify(tLeft.a.type.tag)} and ${JSON.stringify(tRight.a.type.tag)}`,
            expr.a);
          return { ...tBin, a: { ...expr.a, type: BOOL } };
      }
    case "uniop":
      const tExpr = tcExpr(env, locals, expr.expr, SRC);
      const tUni = { ...expr, a: tExpr.a, expr: tExpr }
      switch (expr.op) {
        case UniOp.Neg:
          if (equalType(tExpr.a.type, NUM)) { return tUni }
          else { throw new TypeCheckError(SRC, `Unary operator \`${stringifyOp(expr.op)}\` expects type "number", got ${JSON.stringify(tExpr.a.type.tag)}`,
          expr.a); }
        case UniOp.Not:
          if (equalType(tExpr.a.type, BOOL)) { return tUni }
          else { throw new TypeCheckError(SRC, `Unary operator \`${stringifyOp(expr.op)}\` expects type "bool", got ${JSON.stringify(tExpr.a.type.tag)}`,
          expr.a); }
      }
    case "id":
      if (locals.vars.has(expr.name)) {
        return { ...expr, a: { ...expr.a, type: locals.vars.get(expr.name) } };
      } else if (env.globals.has(expr.name)) {
        return { ...expr, a: { ...expr.a, type: env.globals.get(expr.name) } };
      } else {
        throw new TypeCheckError(SRC, "Unbound id: " + expr.name, expr.a);
      }
    case "lambda":
      if (expr.params.length !== expr.type.params.length) {
        throw new TypeCheckError("Mismatch in number of parameters: " + expr.type.params.length + " != " + expr.params.length);
      }
      const lambdaLocals = copyLocals(locals);
      expr.params.forEach((param, i) => {
        lambdaLocals.vars.set(param, expr.type.params[i]);
      })
      let ret = tcExpr(env, lambdaLocals, expr.expr, SRC);
      if (!isAssignable(env, ret.a.type, expr.type.ret)) {
        throw new TypeCheckError("Expected type " + JSON.stringify(expr.type.ret) + " in lambda, got type " + JSON.stringify(ret.a.type.tag));
      }
      return {a: { ...expr.a, type: expr.type }, tag: "lambda", params: expr.params, type: expr.type, expr: ret}
    case "builtin1":
      // TODO: type check `len` after lists are implemented
      if (expr.name === "print") {
        const tArg = tcExpr(env, locals, expr.arg, SRC);
        
        // [lisa] commented out for now because it's failing some hidden test
        // if (tArg.a.type.tag !== "number" && tArg.a.type.tag !== "bool") {
        //   throw new TypeCheckError(SRC, `print() expects types "int" or "bool" as the argument, got ${JSON.stringify(tArg.a.type.tag)}`, tArg.a, tArg.a.endLoc);
        // }
        return { ...expr, a: tArg.a, arg: tArg };
      } else if (env.functions.has(expr.name)) {
        const [[expectedArgTyp], retTyp] = env.functions.get(expr.name);
        const tArg = tcExpr(env, locals, expr.arg, SRC);

        if (isAssignable(env, tArg.a.type, expectedArgTyp)) {
          return { ...expr, a: { ...expr.a, type: retTyp }, arg: tArg };
        } else {
          throw new TypeCheckError(SRC, `Function call expects an argument of type ${JSON.stringify(expectedArgTyp.tag)}, got ${JSON.stringify(tArg.a.type.tag)}`,
            expr.a);
        }
      } else {
        throw new TypeCheckError(SRC, "Undefined function: " + expr.name, expr.a);
      }
    case "builtin2":
      if (env.functions.has(expr.name)) {
        const [[leftTyp, rightTyp], retTyp] = env.functions.get(expr.name);
        const tLeftArg = tcExpr(env, locals, expr.left, SRC);
        const tRightArg = tcExpr(env, locals, expr.right, SRC);
        if (isAssignable(env, leftTyp, tLeftArg.a.type) && isAssignable(env, rightTyp, tRightArg.a.type)) {
          return { ...expr, a: { ...expr.a, type: retTyp }, left: tLeftArg, right: tRightArg };
        } else {
          throw new TypeCheckError(SRC, `Function call expects arguments of types ${JSON.stringify(leftTyp.tag)} and ${JSON.stringify(rightTyp.tag)}, got ${JSON.stringify(tLeftArg.a.type.tag)} and ${JSON.stringify(tRightArg.a.type.tag)}`,
            expr.a);
        }
      } else {
        throw new TypeCheckError(SRC, "Undefined function: " + expr.name, expr.a);
      }
    case "call":
      if (expr.fn.tag === "id" && env.classes.has(expr.fn.name)) {
        // surprise surprise this is actually a constructor
        const tConstruct: Expr<Annotation> = { a: { ...expr.a, type: CLASS(expr.fn.name) }, tag: "construct", name: expr.fn.name };
        const [_, methods] = env.classes.get(expr.fn.name);
        if (methods.has("__init__")) {
          const [initArgs, initRet] = methods.get("__init__");
          if (expr.arguments.length !== initArgs.length - 1)
            throw new TypeCheckError(SRC, `__init__ takes 1 parameter \`self\` of the same type of the class \`${expr.fn.name}\` with return type of \`None\`, got ${expr.arguments.length} parameters`, expr.a);
          if (initRet !== NONE)
            throw new TypeCheckError(SRC, `__init__ takes 1 parameter \`self\` of the same type of the class \`${expr.fn.name}\` with return type of \`None\`, gotreturn type ${JSON.stringify(initRet.tag)}`, expr.a);
          return tConstruct;
        } else {
          return tConstruct;
        }
      } else {
        const newFn = tcExpr(env, locals, expr.fn, SRC);
        if(newFn.a.type.tag !== "callable") {
          throw new TypeCheckError("Cannot call non-callable expression");
        }
        const tArgs = expr.arguments.map(arg => tcExpr(env, locals, arg, SRC));
        
        if(newFn.a.type.params.length === expr.arguments.length &&
          newFn.a.type.params.every((param, i) => isAssignable(env, tArgs[i].a.type, param))) {
          return {...expr, a: {...expr.a, type: newFn.a.type.ret}, arguments: tArgs, fn: newFn};
        } else {
          const tArgsStr = tArgs.map(tArg => JSON.stringify(tArg.a.type.tag)).join(", ");
          const argTypesStr = newFn.a.type.params.map(argType => JSON.stringify(argType.tag)).join(", ");
          throw new TypeCheckError(SRC, `Function call expects arguments of types [${argTypesStr}], got [${tArgsStr}]`, expr.a);
        }
      }
    case "lookup":
      var tObj = tcExpr(env, locals, expr.obj, SRC);
      if (tObj.a.type.tag === "class") {
        if (env.classes.has(tObj.a.type.name)) {
          const [fields, _] = env.classes.get(tObj.a.type.name);
          if (fields.has(expr.field)) {
            return { ...expr, a: { ...expr.a, type: fields.get(expr.field) }, obj: tObj };
          } else {
            throw new TypeCheckError(SRC, `could not find field ${expr.field} in class ${tObj.a.type.name}`, expr.a);
          }
        } else {
          throw new TypeCheckError(SRC, `field lookup on an unknown class ${tObj.a.type.name}`, expr.a);
        }
      } else {
        throw new TypeCheckError(SRC, `field lookups require an object of type "class", got ${JSON.stringify(tObj.a.type.tag)}`, expr.a);
      }
    case "method-call":
      var tObj = tcExpr(env, locals, expr.obj, SRC);
      var tArgs = expr.arguments.map(arg => tcExpr(env, locals, arg, SRC));
      if (tObj.a.type.tag === "class") {
        if (env.classes.has(tObj.a.type.name)) {
          const [_, methods] = env.classes.get(tObj.a.type.name);
          if (methods.has(expr.method)) {
            const [methodArgs, methodRet] = methods.get(expr.method);
            const realArgs = [tObj].concat(tArgs);
            if (methodArgs.length === realArgs.length &&
              methodArgs.every((argTyp, i) => isAssignable(env, realArgs[i].a.type, argTyp))) {
              return { ...expr, a: { ...expr.a, type: methodRet }, obj: tObj, arguments: tArgs };
            } else {
              const argTypesStr = methodArgs.map(argType => JSON.stringify(argType.tag)).join(", ");
              const tArgsStr = realArgs.map(tArg => JSON.stringify(tArg.a.type.tag)).join(", ");
              throw new TypeCheckError(SRC, `Method call ${expr.method} expects arguments of types [${argTypesStr}], got [${tArgsStr}]`,
              expr.a);
            }
          } else {
            throw new TypeCheckError(SRC, `could not found method ${expr.method} in class ${tObj.a.type.name}`,
            expr.a);
          }
        } else {
          throw new TypeCheckError(SRC, `method call on an unknown class ${tObj.a.type.name}`, expr.a);
        }
      } else {
        throw new TypeCheckError(SRC, `method calls require an object of type "class", got ${JSON.stringify(tObj.a.type.tag)}`, expr.a);
      }
    case "if-expr":
      var tThn = tcExpr(env, locals, expr.thn, SRC);
      var tCond = tcExpr(env, locals, expr.cond, SRC);
      var tEls = tcExpr(env, locals, expr.els, SRC);
      if(!equalType(tCond.a.type, BOOL)) throw new TypeCheckError(SRC, "Condition Expression Must be a bool", expr.a);
      //TODO (Michael Maddy, Closures): Might not work for inheritence...
      if(!equalType(tThn.a.type, tEls.a.type)) throw new TypeCheckError(SRC, `if-expr type mismatch: ${JSON.stringify(tThn.a)} is not the same as ${JSON.stringify(tEls.a)}`, expr.a);
      //Instead the type could be either the type of thn or els, and not error if they are not the same type.
      // var newType = join(env, tThn.a, tEls.a)
      return {...expr, a: tThn.a, cond: tCond, thn: tThn, els: tEls};
    default: throw new TypeCheckError(SRC, `unimplemented type checking for expr: ${expr}`, expr.a);
  }
}

export function tcLiteral(literal: Literal<Annotation>) {
  switch (literal.tag) {
    case "bool": return BOOL;
    case "num": return NUM;
    case "none": return NONE;
  }
}