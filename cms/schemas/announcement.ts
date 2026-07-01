import { defineType, defineField } from 'sanity';

export default defineType({
  name: 'announcement',
  title: 'Site Announcement Banner',
  type: 'document',
  fields: [
    defineField({
      name: 'message',
      title: 'Announcement Message',
      type: 'text',
      rows: 2,
      description: 'সাইটের উপরে দেখানোর জন্য টেক্সট (যেমন: "Welcome to CryptoFlip! Enjoy instant rakebacks.")।',
      validation: (Rule) => Rule.required(),
    }),
    defineField({
      name: 'type',
      title: 'Banner Type',
      type: 'string',
      options: {
        list: [
          { title: 'Information (Blue)', value: 'info' },
          { title: 'Success (Green)', value: 'success' },
          { title: 'Warning (Gold)', value: 'warning' },
          { title: 'Danger / Alert (Red)', value: 'alert' },
        ],
        layout: 'radio',
      },
      initialValue: 'info',
      validation: (Rule) => Rule.required(),
    }),
    defineField({
      name: 'linkUrl',
      title: 'Action Link URL',
      type: 'string',
      description: 'অ্যানাউন্সমেন্ট ব্যানারটিতে ক্লিক করলে কোন পেজে নিয়ে যাবে (ঐচ্ছিক)।',
    }),
    defineField({
      name: 'isActive',
      title: 'Is Active',
      type: 'boolean',
      initialValue: true,
      description: 'ব্যানারটি সাইটে প্রদর্শন করতে এটি টিক দিয়ে রাখুন।',
    }),
    defineField({
      name: 'startDate',
      title: 'Schedule Start Date',
      type: 'datetime',
      description: 'কবে থেকে ব্যানারটি চালু হবে (ঐচ্ছিক)।',
    }),
    defineField({
      name: 'endDate',
      title: 'Schedule End Date',
      type: 'datetime',
      description: 'কবে স্বয়ংক্রিয়ভাবে বন্ধ হয়ে যাবে (ঐচ্ছিক)।',
    }),
  ],
});
