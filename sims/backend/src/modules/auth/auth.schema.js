'use strict';
const { z } = require('zod');

// bcrypt only uses the first 72 bytes, so cap there rather than silently truncating.
const password = z.string()
  .min(8, 'Password must be at least 8 characters')
  .max(72, 'Password must be at most 72 characters')
  .regex(/[A-Za-z]/, 'Password must contain a letter')
  .regex(/\d/, 'Password must contain a number');

const email = z.string().trim().toLowerCase().email('Enter a valid email').max(254);
const fullName = z.string().trim().min(2, 'Name is too short').max(120);
const phone = z.string().trim().min(7).max(20).regex(/^[0-9+\-() ]+$/, 'Invalid phone number').optional();
const text = (max = 300) => z.string().trim().max(max).optional();
const keyString = z.string().trim().min(8).max(24);
const uuid = z.string().uuid();

const account = { fullName, email, password, phone };

const signupUniversityHead = z.object({
  ...account,
  university: z.object({
    name: z.string().trim().min(2).max(200),
    headTitle: z.enum(['Chancellor', 'Vice-Chancellor', 'Head']).default('Vice-Chancellor'),
    headName: text(120),                 // defaults to the account's full name
    address: text(500),
    contactEmail: z.string().trim().toLowerCase().email().optional(),
    contactPhone: phone,
  }),
});

const signupCollegeAdmin = z.object({
  ...account,
  universityKey: keyString,
  college: z.object({
    name: z.string().trim().min(2).max(200),
    address: text(500),
    affiliation: text(200),
    principalName: z.string().trim().min(2).max(120),
    contactEmail: z.string().trim().toLowerCase().email().optional(),
    contactPhone: phone,
  }),
});

const signupInstructor = z.object({ ...account, collegeKey: keyString, departmentId: uuid.optional() });
const signupStudent = z.object({ ...account });

const login = z.object({ email, password: z.string().min(1).max(200) });
const forgotPassword = z.object({ email });
const resetPassword = z.object({ token: z.string().min(20).max(200), password });
const changePassword = z.object({ currentPassword: z.string().min(1).max(200), newPassword: password });
const updateMe = z.object({ fullName: fullName.optional(), phone: phone.nullable().optional() })
  .refine((v) => Object.keys(v).length > 0, 'Nothing to update');

module.exports = {
  signupUniversityHead, signupCollegeAdmin, signupInstructor, signupStudent,
  login, forgotPassword, resetPassword, changePassword, updateMe,
  shared: { uuid, keyString, text, phone },
};
