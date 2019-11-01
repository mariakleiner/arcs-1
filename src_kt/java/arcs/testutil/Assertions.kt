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

package arcs.testutil

import org.junit.Assert.fail
import kotlin.reflect.KClass

/** Utility to assert that a lambda throws a specific exception type. */
fun assertThrows(expected: KClass<out Exception>, thrower: () -> Unit) {
    try {
        thrower()
    } catch (e: Exception) {
        assert(expected.java.isInstance(e)) {
            "Expected exception of type ${expected}, but was ${e.javaClass}"
        }
        return
    }
    fail("Expected exception of type $expected, but none was thrown.")
}