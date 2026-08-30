import { makeUser } from "../domain/user.mjs";
import { userRepository } from "../repositories/user-repository.mjs";
import { nextId } from "../utils/id-generator.mjs";
import { assertValidEmail } from "../validators/user-validator.mjs";

export function createUser(name, email) {
  assertValidEmail(email);
  return userRepository.save(makeUser(nextId("user"), name, email));
}
