import { describe, it, expect } from 'vitest';
import {
  toToolName,
  toToolTitle,
  toFileName,
  toFunctionName,
} from '../../src/transformer/naming.js';

describe('naming', () => {
  describe('toToolName', () => {
    it('converts camelCase to snake_case', () => {
      expect(toToolName('listPets')).toBe('list_pets');
      expect(toToolName('getPetById')).toBe('get_pet_by_id');
      expect(toToolName('createPet')).toBe('create_pet');
    });

    it('converts PascalCase to snake_case', () => {
      expect(toToolName('ListPets')).toBe('list_pets');
      expect(toToolName('ShowPetById')).toBe('show_pet_by_id');
    });

    it('handles already snake_case', () => {
      expect(toToolName('list_pets')).toBe('list_pets');
    });

    it('handles kebab-case', () => {
      expect(toToolName('list-pets')).toBe('list_pets');
    });
  });

  describe('toToolTitle', () => {
    it('converts to title case', () => {
      expect(toToolTitle('listPets')).toBe('List Pets');
      expect(toToolTitle('showPetById')).toBe('Show Pet By Id');
    });
  });

  describe('toFileName', () => {
    it('converts to kebab-case', () => {
      expect(toFileName('listPets')).toBe('list-pets');
      expect(toFileName('showPetById')).toBe('show-pet-by-id');
    });
  });

  describe('toFunctionName', () => {
    it('converts to camelCase', () => {
      expect(toFunctionName('listPets')).toBe('listPets');
      expect(toFunctionName('ShowPetById')).toBe('showPetById');
    });
  });
});
