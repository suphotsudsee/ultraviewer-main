OwnView Agent สำหรับเครื่อง user2

ไฟล์ชุดนี้ตั้งค่า server ไว้แล้ว:
https://suphottunnel.phoubon.in.th

วิธีใช้งาน:
1. แตก/คัดลอกโฟลเดอร์นี้ไปไว้บนเครื่อง user2
2. ดับเบิลคลิก START_USER2_AGENT.bat หรือ OwnViewAgent.exe
3. หน้าต่าง OwnView Agent ต้องเปิดค้างไว้ตลอดเวลาที่ต้องการรับการช่วยเหลือ
4. เมื่อ user1 ขอเชื่อมต่อ ให้ user2 ตรวจสอบแล้วกด Approve visible support
5. ถ้าต้องการหยุด ให้กด Reject / Stop หรือปิดหน้าต่าง Agent

ไฟล์ตั้งค่า:
agentsettings.json

ค่า allowRemoteInput ตอนนี้เป็น true:
- user1 สามารถควบคุม mouse/keyboard ได้หลังจาก user2 กด Approve
- user2 หยุดได้ทุกเมื่อด้วย Reject / Stop

ข้อกำหนด:
- Windows 10/11 64-bit
- ใช้ internet ได้
- ไม่ต้องติดตั้ง .NET แยก เพราะชุดนี้เป็น self-contained
