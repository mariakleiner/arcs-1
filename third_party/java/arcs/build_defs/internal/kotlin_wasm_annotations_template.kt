/*
 * Copyright 2019 Google LLC.
 *
 * This code may only be used under the BSD style license found at
 * http://polymer.github.io/LICENSE.txt
 *
 * Code distributed by Google as part of this project is also subject to an additional IP rights
 * grant found at
 * http://polymer.github.io/PATENTS.txt
 */

// File generated by {label}.
// This file exports a factory function for a wasm particle so that it can be constructed by
// JavaScript. It should be included in wasm builds only, not for jvm builds.

package {package}

import arcs.wasm.toAddress
import kotlin.native.Retain
import kotlin.native.internal.ExportForCppRuntime

@Retain
@ExportForCppRuntime()
fun _new{particle}() = {particle}().toAddress()