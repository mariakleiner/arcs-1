/**
 * @license
 * Copyright (c) 2017 Google Inc. All rights reserved.
 * This code may only be used under the BSD style license found at
 * http://polymer.github.io/LICENSE.txt
 * Code distributed by Google as part of this project is also
 * subject to an additional IP rights grant found at
 * http://polymer.github.io/PATENTS.txt
 */
'use strict';

import {assert} from '../platform/assert-web.js';
import {ParticleSpec} from './ts-build/particle-spec.js';
import {Type} from './ts-build/type.js';
import {OuterPortAttachment} from './ts-build/debug/outer-port-attachment.js';
import {DevtoolsConnection} from './ts-build/debug/devtools-connection.js';

class ThingMapper {
  constructor(prefix) {
    this._prefix = prefix;
    this._nextIdentifier = 0;
    this._idMap = new Map();
    this._reverseIdMap = new Map();
  }

  _newIdentifier() {
    return this._prefix + (this._nextIdentifier++);
  }

  createMappingForThing(thing, requestedId) {
    assert(!this._reverseIdMap.has(thing));
    let id;
    if (requestedId) {
      id = requestedId;
    } else if (thing.apiChannelMappingId) {
      id = thing.apiChannelMappingId;
    } else {
      id = this._newIdentifier();
    }
    assert(!this._idMap.has(id), `${requestedId ? 'requestedId' : (thing.apiChannelMappingId ? 'apiChannelMappingId' : 'newIdentifier()')} ${id} already in use`);
    this.establishThingMapping(id, thing);
    return id;
  }

  maybeCreateMappingForThing(thing) {
    if (this.hasMappingForThing(thing)) {
      return this.identifierForThing(thing);
    }
    return this.createMappingForThing(thing);
  }

  async establishThingMapping(id, thing) {
    let continuation;
    if (Array.isArray(thing)) {
      [thing, continuation] = thing;
    }
    this._idMap.set(id, thing);
    if (thing instanceof Promise) {
      assert(continuation == null);
      await this.establishThingMapping(id, await thing);
    } else {
      this._reverseIdMap.set(thing, id);
      if (continuation) {
        await continuation();
      }
    }
  }

  hasMappingForThing(thing) {
    return this._reverseIdMap.has(thing);
  }

  identifierForThing(thing) {
    assert(this._reverseIdMap.has(thing), `Missing thing [${thing}]`);
    return this._reverseIdMap.get(thing);
  }

  thingForIdentifier(id) {
    assert(this._idMap.has(id), `Missing id: ${id}`);
    return this._idMap.get(id);
  }
}


export class APIPort {
  constructor(messagePort, prefix) {
    this._port = messagePort;
    this._mapper = new ThingMapper(prefix);
    this._messageMap = new Map();
    this._port.onmessage = async e => this._processMessage(e);
    this._debugAttachment = null;
    this._attachStack = false;
    this.messageCount = 0;

    this.Direct = {
      convert: a => a,
      unconvert: a => a
    };

    this.LocalMapped = {
      convert: a => this._mapper.maybeCreateMappingForThing(a),
      unconvert: a => this._mapper.thingForIdentifier(a)
    };

    this.Mapped = {
      convert: a => this._mapper.identifierForThing(a),
      unconvert: a => this._mapper.thingForIdentifier(a)
    };

    this.Map = function(keyprimitive, valueprimitive) {
      return {
        convert: a => {
          const r = {};
          a.forEach((value, key) => r[keyprimitive.convert(key)] = valueprimitive.convert(value));
          return r;
        },
        unconvert: a => {
          const r = new Map();
          for (const key in a) {
            r.set(
                keyprimitive.unconvert(key), valueprimitive.unconvert(a[key]));
          }
          return r;
        }
      };
    };

    this.List = function(primitive) {
      return {
        convert: a => a.map(v => primitive.convert(v)),
        unconvert: a => a.map(v => primitive.unconvert(v))
      };
    };

    this.ByLiteral = function(clazz) {
      return {
        convert: a => a.toLiteral(),
        unconvert: a => clazz.fromLiteral(a)
      };
    };

    this._testingHook();
  }

  // Overridden by unit tests.
  _testingHook() {
  }

  close() {
    this._port.close();
  }

  async _processMessage(e) {
    assert(this._messageMap.has(e.data.messageType));

    const cnt = this.messageCount++;

    const handler = this._messageMap.get(e.data.messageType);
    let args;
    try {
      args = this._unprocessArguments(handler.args, e.data.messageBody);
    } catch (exc) {
      console.error(`Exception during unmarshaling for ${e.data.messageType}`);
      throw exc;
    }
    // If any of the converted arguments are still pending promises
    // wait for them to complete before processing the message.
    for (const arg of Object.values(args)) {
      if (arg instanceof Promise) {
        arg.then(() => this._processMessage(e));
        return;
      }
    }
    const handlerName = 'on' + e.data.messageType;
    assert(this[handlerName], `no handler named ${handlerName}`);
    if (this._debugAttachment) {
      this._debugAttachment.handlePecMessage(handlerName, e.data.messageBody, cnt, e.data.stack);
    }
    const result = this[handlerName](args);
    if (handler.isInitializer) {
      assert(args.identifier);
      await this._mapper.establishThingMapping(args.identifier, result);
    }
  }

  _processArguments(argumentTypes, args) {
    const messageBody = {};
    for (const argument in argumentTypes) {
      messageBody[argument] = argumentTypes[argument].convert(args[argument]);
    }
    return messageBody;
  }

  _unprocessArguments(argumentTypes, args) {
    const messageBody = {};
    for (const argument in argumentTypes) {
      messageBody[argument] = argumentTypes[argument].unconvert(args[argument]);
    }
    return messageBody;
  }

  registerCall(name, argumentTypes) {
    this[name] = args => {
      const call = {messageType: name, messageBody: this._processArguments(argumentTypes, args)};
      if (this._attachStack) call.stack = new Error().stack;
      const cnt = this.messageCount++;
      this._port.postMessage(call);
      if (this._debugAttachment) {
        this._debugAttachment.handlePecMessage(name, call.messageBody, cnt, new Error().stack);
      }
    };
  }

  registerHandler(name, argumentTypes) {
    this._messageMap.set(name, {args: argumentTypes});
  }

  registerInitializerHandler(name, argumentTypes) {
    argumentTypes.identifier = this.Direct;
    this._messageMap.set(name, {
      isInitializer: true,
      args: argumentTypes,
    });
  }

  registerRedundantInitializer(name, argumentTypes, mappingIdArg) {
    this.registerInitializer(name, argumentTypes, mappingIdArg, true /* redundant */);
  }

  registerInitializer(name, argumentTypes, mappingIdArg = null, redundant = false) {
    this[name] = (thing, args) => {
      if (redundant && this._mapper.hasMappingForThing(thing)) return;
      const call = {messageType: name, messageBody: this._processArguments(argumentTypes, args)};
      if (this._attachStack) call.stack = new Error().stack;
      const requestedId = mappingIdArg && args[mappingIdArg];
      call.messageBody.identifier = this._mapper.createMappingForThing(thing, requestedId);
      const cnt = this.messageCount++;
      this._port.postMessage(call);
      if (this._debugAttachment) {
        this._debugAttachment.handlePecMessage(name, call.messageBody, cnt, new Error().stack);
      }
    };
  }
}

export class PECOuterPort extends APIPort {
  constructor(messagePort, arc) {
    super(messagePort, 'o');

    this.registerCall('Stop', {});
    this.registerRedundantInitializer('DefineHandle', {type: this.ByLiteral(Type), name: this.Direct});
    this.registerInitializer('InstantiateParticle',
      {id: this.Direct, spec: this.ByLiteral(ParticleSpec), handles: this.Map(this.Direct, this.Mapped)}, 'id');

    this.registerCall('UIEvent', {particle: this.Mapped, slotName: this.Direct, event: this.Direct});
    this.registerCall('SimpleCallback', {callback: this.Direct, data: this.Direct});
    this.registerCall('AwaitIdle', {version: this.Direct});
    this.registerCall('StartRender', {particle: this.Mapped, slotName: this.Direct, providedSlots: this.Map(this.Direct, this.Direct), contentTypes: this.List(this.Direct)});
    this.registerCall('StopRender', {particle: this.Mapped, slotName: this.Direct});

    this.registerHandler('Render', {particle: this.Mapped, slotName: this.Direct, content: this.Direct});
    this.registerHandler('InitializeProxy', {handle: this.Mapped, callback: this.Direct});
    this.registerHandler('SynchronizeProxy', {handle: this.Mapped, callback: this.Direct});
    this.registerHandler('HandleGet', {handle: this.Mapped, callback: this.Direct});
    this.registerHandler('HandleToList', {handle: this.Mapped, callback: this.Direct});
    this.registerHandler('HandleSet', {handle: this.Mapped, data: this.Direct, particleId: this.Direct, barrier: this.Direct});
    this.registerHandler('HandleClear', {handle: this.Mapped, particleId: this.Direct, barrier: this.Direct});
    this.registerHandler('HandleStore', {handle: this.Mapped, callback: this.Direct, data: this.Direct, particleId: this.Direct});
    this.registerHandler('HandleRemove', {handle: this.Mapped, callback: this.Direct, data: this.Direct, particleId: this.Direct});
    this.registerHandler('HandleRemoveMultiple', {handle: this.Mapped, callback: this.Direct, data: this.Direct, particleId: this.Direct});
    this.registerHandler('HandleStream', {handle: this.Mapped, callback: this.Direct, pageSize: this.Direct, forward: this.Direct});
    this.registerHandler('StreamCursorNext', {handle: this.Mapped, callback: this.Direct, cursorId: this.Direct});
    this.registerHandler('StreamCursorClose', {handle: this.Mapped, cursorId: this.Direct});

    this.registerHandler('Idle', {version: this.Direct, relevance: this.Map(this.Mapped, this.Direct)});

    this.registerHandler('GetBackingStore', {callback: this.Direct, storageKey: this.Direct, type: this.ByLiteral(Type)});
    this.registerInitializer('GetBackingStoreCallback', {callback: this.Direct, type: this.ByLiteral(Type), name: this.Direct, id: this.Direct, storageKey: this.Direct});

    this.registerHandler('ConstructInnerArc', {callback: this.Direct, particle: this.Mapped});
    this.registerCall('ConstructArcCallback', {callback: this.Direct, arc: this.LocalMapped});

    this.registerHandler('ArcCreateHandle', {callback: this.Direct, arc: this.LocalMapped, type: this.ByLiteral(Type), name: this.Direct});
    this.registerInitializer('CreateHandleCallback', {callback: this.Direct, type: this.ByLiteral(Type), name: this.Direct, id: this.Direct});
    this.registerHandler('ArcMapHandle', {callback: this.Direct, arc: this.LocalMapped, handle: this.Mapped});
    this.registerInitializer('MapHandleCallback', {callback: this.Direct, id: this.Direct});
    this.registerHandler('ArcCreateSlot',
      {callback: this.Direct, arc: this.LocalMapped, transformationParticle: this.Mapped, transformationSlotName: this.Direct, hostedParticleName: this.Direct, hostedSlotName: this.Direct, handleId: this.Direct});
    this.registerInitializer('CreateSlotCallback', {callback: this.Direct, hostedSlotId: this.Direct});
    this.registerCall('InnerArcRender', {transformationParticle: this.Mapped, transformationSlotName: this.Direct, hostedSlotId: this.Direct, content: this.Direct});

    this.registerHandler('ArcLoadRecipe', {arc: this.LocalMapped, recipe: this.Direct, callback: this.Direct});

    this.registerHandler('RaiseSystemException', {exception: this.Direct, methodName: this.Direct, particleId: this.Direct});

    // We need an API call to tell the context side that DevTools has been connected, so it can start sending
    // stack traces attached to the API calls made from that side.
    this.registerCall('DevToolsConnected', {});
    DevtoolsConnection.onceConnected.then(devtoolsChannel => {
      this.DevToolsConnected();
      this._debugAttachment = new OuterPortAttachment(arc, devtoolsChannel);
    });
  }
}

export class PECInnerPort extends APIPort {
  constructor(messagePort) {
    super(messagePort, 'i');

    this.registerHandler('Stop', {});
    this.registerInitializerHandler('DefineHandle', {type: this.ByLiteral(Type), name: this.Direct});
    this.registerInitializerHandler('InstantiateParticle',
      {id: this.Direct, spec: this.ByLiteral(ParticleSpec), handles: this.Map(this.Direct, this.Mapped)});

    this.registerHandler('UIEvent', {particle: this.Mapped, slotName: this.Direct, event: this.Direct});
    this.registerHandler('SimpleCallback', {callback: this.LocalMapped, data: this.Direct});
    this.registerHandler('AwaitIdle', {version: this.Direct});
    this.registerHandler('StartRender', {particle: this.Mapped, slotName: this.Direct, providedSlots: this.Map(this.Direct, this.Direct), contentTypes: this.List(this.Direct)});
    this.registerHandler('StopRender', {particle: this.Mapped, slotName: this.Direct});

    this.registerCall('Render', {particle: this.Mapped, slotName: this.Direct, content: this.Direct});
    this.registerCall('InitializeProxy', {handle: this.Mapped, callback: this.LocalMapped});
    this.registerCall('SynchronizeProxy', {handle: this.Mapped, callback: this.LocalMapped});
    this.registerCall('HandleGet', {handle: this.Mapped, callback: this.LocalMapped});
    this.registerCall('HandleToList', {handle: this.Mapped, callback: this.LocalMapped});
    this.registerCall('HandleSet', {handle: this.Mapped, data: this.Direct, particleId: this.Direct, barrier: this.Direct});
    this.registerCall('HandleClear', {handle: this.Mapped, particleId: this.Direct, barrier: this.Direct});
    this.registerCall('HandleStore', {handle: this.Mapped, callback: this.LocalMapped, data: this.Direct, particleId: this.Direct});
    this.registerCall('HandleRemove', {handle: this.Mapped, callback: this.LocalMapped, data: this.Direct, particleId: this.Direct});
    this.registerCall('HandleRemoveMultiple', {handle: this.Mapped, callback: this.LocalMapped, data: this.Direct, particleId: this.Direct});
    this.registerCall('HandleStream', {handle: this.Mapped, callback: this.LocalMapped, pageSize: this.Direct, forward: this.Direct});
    this.registerCall('StreamCursorNext', {handle: this.Mapped, callback: this.LocalMapped, cursorId: this.Direct});
    this.registerCall('StreamCursorClose', {handle: this.Mapped, cursorId: this.Direct});

    this.registerCall('Idle', {version: this.Direct, relevance: this.Map(this.Mapped, this.Direct)});

    this.registerCall('GetBackingStore', {callback: this.LocalMapped, storageKey: this.Direct, type: this.ByLiteral(Type)});
    this.registerInitializerHandler('GetBackingStoreCallback', {callback: this.LocalMapped, type: this.ByLiteral(Type), name: this.Direct, id: this.Direct, storageKey: this.Direct});

    this.registerCall('ConstructInnerArc', {callback: this.LocalMapped, particle: this.Mapped});
    this.registerHandler('ConstructArcCallback', {callback: this.LocalMapped, arc: this.Direct});

    this.registerCall('ArcCreateHandle', {callback: this.LocalMapped, arc: this.Direct, type: this.ByLiteral(Type), name: this.Direct});
    this.registerInitializerHandler('CreateHandleCallback', {callback: this.LocalMapped, type: this.ByLiteral(Type), name: this.Direct, id: this.Direct});
    this.registerCall('ArcMapHandle', {callback: this.LocalMapped, arc: this.Direct, handle: this.Mapped});
    this.registerInitializerHandler('MapHandleCallback', {callback: this.LocalMapped, id: this.Direct});
    this.registerCall('ArcCreateSlot',
      {callback: this.LocalMapped, arc: this.Direct, transformationParticle: this.Mapped, transformationSlotName: this.Direct, hostedParticleName: this.Direct, hostedSlotName: this.Direct, handleId: this.Direct});
    this.registerInitializerHandler('CreateSlotCallback', {callback: this.LocalMapped, hostedSlotId: this.Direct});
    this.registerHandler('InnerArcRender', {transformationParticle: this.Mapped, transformationSlotName: this.Direct, hostedSlotId: this.Direct, content: this.Direct});

    this.registerCall('ArcLoadRecipe', {arc: this.Direct, recipe: this.Direct, callback: this.LocalMapped});

    this.registerCall('RaiseSystemException', {exception: this.Direct, methodName: this.Direct, particleId: this.Direct});

    // To show stack traces for calls made inside the context, we need to capture the trace at the call point and
    // send it along with the message. We only want to do this after a DevTools connection has been detected, which
    // we can't directly detect inside a worker context, so the PECOuterPort will send an API message instead.
    this.registerHandler('DevToolsConnected', {});
    this.onDevToolsConnected = () => this._attachStack = true;
  }
}
